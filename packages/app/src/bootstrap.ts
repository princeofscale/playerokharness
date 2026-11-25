import path from 'node:path';
import {
  AccessService,
  BlacklistService,
  BootReportService,
  Context,
  LockService,
  LogSinkService,
  PluginManagerService,
  safeInterval,
  StorageService,
  UpdaterService,
  VERSION,
  type SetupProblem,
} from '@pkh/core';
import {
  MockPlayerokTransport,
  PlayerokService,
  type MockTransportSeed,
  type PlayerokTransport,
} from '@pkh/adapter';
import { mountAutomation } from '@pkh/plugin-automation';
import { RetryQueueService } from '@pkh/plugin-retry-queue';
import { TelegramService } from '@pkh/plugin-telegram';
import { WebDashboardService } from '@pkh/plugin-web';

export interface AppOptions {
  dataDir?: string;
  pluginsDir?: string;
  dryRun?: boolean;
  enableTelegram?: boolean;
  enableTimers?: boolean;
  enableInstanceLock?: boolean;
  enableSetupMode?: boolean;
  silentConsole?: boolean;
  transport?: PlayerokTransport;
  mockSeed?: MockTransportSeed;
  telegramToken?: string;
  autoRecheckIntervalMs?: number;
  /** Mount the read-only HTTP dashboard (defaults off; also enabled by PKH_WEB_ENABLED). */
  enableWeb?: boolean;
  webHost?: string;
  webPort?: number;
  webToken?: string;
}

export interface PlayerokApplication {
  ctx: Context;
  start(): Promise<void>;
  stop(): Promise<void>;
  launchPlayerok(): Promise<SetupProblem | null>;
  isInSetupMode(): boolean;
}

export async function createApplication(options: AppOptions = {}): Promise<PlayerokApplication> {
  const dataDir = path.resolve(options.dataDir ?? process.cwd());
  const ctx = new Context();

  await ctx.use(StorageService, { baseDir: dataDir });
  await ctx.use(LogSinkService, { silentConsole: options.silentConsole });
  await ctx.use(LockService);
  await ctx.use(AccessService);
  await ctx.use(BlacklistService);
  await ctx.use(BootReportService);
  await ctx.use(UpdaterService, {
    currentVersion: VERSION,
    enableTimer: options.enableTimers ?? true,
  });
  await ctx.use(PluginManagerService, {
    pluginsDir: options.pluginsDir ?? path.join(dataDir, 'plugins'),
  });

  await ctx.use(PlayerokService, {
    dryRun: options.dryRun,
    transport: options.transport,
    mockSeed: options.mockSeed,
    enableMaintenanceLoops: options.enableTimers ?? true,
  });

  // Contract-drift watchdog: PlayerOK can rename a GraphQL field without notice. The
  // transport records those as ContractIssue[] and keeps mapping best-effort, so the
  // only way to notice is to look — surface the first occurrences in the log.
  if (options.enableTimers !== false) {
    let reportedContractIssues = 0;
    safeInterval(
      ctx,
      () => {
        const issues = ctx.playerok.getContractIssues();
        if (issues.length <= reportedContractIssues) return;
        reportedContractIssues = issues.length;
        const sample = issues
          .slice(-3)
          .map((issue) => `${issue.op} [${issue.paths.join(', ')}]`)
          .join('; ');
        ctx.logger('playerok').warn(`Дрейф контракта PlayerOK API: ${sample}`);
      },
      10 * 60 * 1000,
      'playerok:contractDrift',
    );
  }

  await ctx.use(RetryQueueService, {
    enableTimer: options.enableTimers ?? true,
  });

  // Mounted on the root context on purpose: services provided inside a nested bundle
  // are invisible to root-level consumers such as the Telegram panel and the web
  // dashboard, which must read autoBump/autoRestore/autoWithdrawal through ctx.get().
  mountAutomation(ctx, {
    enableTimers: options.enableTimers ?? true,
  });

  const webEnabled = options.enableWeb ?? isTruthyEnv(process.env.PKH_WEB_ENABLED);
  // The dashboard binds inside an effect, which cordis does not await; `ready` keeps
  // startup ordering deterministic and turns a bind failure into a log line.
  await ctx.use(WebDashboardService, {
    enabled: webEnabled,
    host: options.webHost ?? process.env.PKH_WEB_HOST,
    port: options.webPort ?? (process.env.PKH_WEB_PORT ? Number(process.env.PKH_WEB_PORT) : undefined),
    token: options.webToken ?? process.env.PKH_WEB_TOKEN,
  });

  const dashboard = ctx.get('webDashboard', false);
  if (dashboard) {
    await dashboard.ready;
    if (dashboard.startupError) {
      ctx.logger('pkh').error(`Веб-панель недоступна: ${dashboard.startupError.message}`);
    }
  }

  if (options.enableTelegram !== false) {
    await ctx.use(TelegramService, {
      token: options.telegramToken,
    });
  }

  let started = false;
  let stopped = false;
  let playerokLaunched = false;
  let disposeRecheck: (() => Promise<void>) | null = null;

  const stopRecheckTimer = () => {
    if (disposeRecheck) {
      void disposeRecheck();
      disposeRecheck = null;
    }
  };

  const launchPlayerok = async (): Promise<SetupProblem | null> => {
    const log = ctx.logger('pkh');
    await ctx.playerok.reconfigureTransport();
    const problem = await ctx.playerok.diagnose();
    if (problem) {
      return problem;
    }

    stopRecheckTimer();
    const account = ctx.playerok.account!;

    if (options.enableInstanceLock !== false) {
      const accPid = ctx.lock.acquireAccountLock(account.id);
      if (accPid !== null) {
        throw new Error(
          `Аккаунт ${account.username} (${account.id}) уже обслуживается другим процессом (PID ${accPid}).`,
        );
      }
    }

    if (!playerokLaunched) {
      playerokLaunched = true;
      await ctx.plugins.discoverAndLoad();
      ctx.plugins.verifyRequiredPlugins();
      await ctx.playerok.startListening();
      await ctx.parallel('bot/init');
      await ctx.parallel('bot/ready');
      log.info(
        `PlayerOK Harness готов к работе (аккаунт: ${account.username}, режим: ${ctx.playerok.isDryRun ? 'DRY-RUN' : ctx.playerok.transport.kind})`,
      );
      if (options.enableTelegram !== false && ctx.telegram?.bot) {
        await ctx.telegram.sendBootReport();
      }
    }

    return null;
  };

  if (options.enableTelegram !== false && ctx.telegram) {
    ctx.telegram.setSetupLauncher(launchPlayerok);
  }

  return {
    ctx,
    isInSetupMode(): boolean {
      return ctx.playerok.setupProblem !== null;
    },
    launchPlayerok,
    async start(): Promise<void> {
      if (started) return;
      started = true;

      const log = ctx.logger('pkh');
      log.info(`Запуск PlayerOK Harness v${VERSION} (Cordis 4 + TypeScript)`);

      if (options.enableInstanceLock !== false) {
        const runningPid = ctx.lock.acquireInstanceLock();
        if (runningPid !== null) {
          throw new Error(
            `Бот из каталога ${dataDir} уже запущен (PID ${runningPid}). Остановите предыдущий процесс.`,
          );
        }
      }

      if (options.enableTelegram !== false && ctx.telegram?.bot) {
        await ctx.telegram.start();
      }

      const problem = await launchPlayerok();
      if (problem) {
        if (options.enableSetupMode === false) {
          throw new Error(problem.text);
        }
        log.warn(`Работа с PlayerOK приостановлена (Setup Mode): ${problem.text}`);
        await ctx.parallel('bot/setup-mode', problem);

        if (options.enableTimers !== false) {
          const interval = options.autoRecheckIntervalMs ?? 5 * 60 * 1000;
          disposeRecheck = safeInterval(
            ctx,
            async () => {
              const current = ctx.playerok.setupProblem;
              if (!current || !current.transient) return;
              await launchPlayerok();
            },
            interval,
            'setupMode:autoRecheck',
          );
        }
      }
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      stopRecheckTimer();
      await ctx.parallel('bot/shutdown');
      await ctx.fiber.dispose();
    },
  };
}

export async function runDryRunSimulation(ctx: Context): Promise<void> {
  const log = ctx.logger('simulate');
  if (!(ctx.playerok.transport instanceof MockPlayerokTransport)) {
    throw new Error('Симуляция доступна только в режиме --dry-run (MockPlayerokTransport)');
  }
  const mock = ctx.playerok.transport;

  ctx.storage.updateConfig((cfg) => {
    cfg.playerok.auto_complete_deals.enabled = true;
    cfg.playerok.auto_restore_items.sold = true;
  });
  ctx.storage.set('auto_deliveries', [
    {
      keyphrases: ['Steam Key'],
      piece: true,
      goods: ['STEAM-XXXX-YYYY-ZZZZ', 'STEAM-AAAA-BBBB-CCCC'],
    },
  ]);

  const buyer = { id: 'sim-buyer-1', username: 'TestBuyer' };
  log.info('1) Симуляция входящего сообщения от нового покупателя...');
  await mock.simulateNewMessage('chat-sim-1', buyer, 'Здравствуйте! Есть в наличии?');

  log.info('2) Симуляция команды !продавец...');
  await mock.simulateNewMessage('chat-sim-1', buyer, '!продавец');

  log.info('3) Симуляция новой сделки (авто-выдача + авто-подтверждение + авто-восстановление)...');
  await mock.simulateNewDeal({
    buyer,
    chatId: 'chat-sim-1',
    itemId: '11111111-1111-1111-1111-111111111111',
  });

  log.info(
    `Итог симуляции: отправлено сообщений=${mock.sentMessages.length}, обновлено сделок=${mock.updatedDeals.length}, восстановлено товаров=${mock.publishedItems.length}`,
  );
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
