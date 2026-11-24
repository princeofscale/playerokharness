import path from 'node:path';
import {
  AccessService,
  BlacklistService,
  BootReportService,
  Context,
  LockService,
  LogSinkService,
  PluginManagerService,
  StorageService,
  UpdaterService,
  VERSION,
  type SetupProblem,
} from '@playerok/core';
import {
  MockPlayerokTransport,
  PlayerokService,
  type MockTransportSeed,
  type PlayerokTransport,
} from '@playerok/adapter';
import { automationBundle } from '@playerok/plugin-automation';
import { TelegramService } from '@playerok/plugin-telegram';

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

  await ctx.use(automationBundle, {
    enableTimers: options.enableTimers ?? true,
  });

  if (options.enableTelegram !== false) {
    await ctx.use(TelegramService, {
      token: options.telegramToken,
    });
  }

  let started = false;
  let stopped = false;
  let playerokLaunched = false;
  let recheckTimer: NodeJS.Timeout | null = null;

  const stopRecheckTimer = () => {
    if (recheckTimer) {
      clearInterval(recheckTimer);
      recheckTimer = null;
    }
  };

  const launchPlayerok = async (): Promise<SetupProblem | null> => {
    const log = ctx.logger('universal');
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
      await ctx.playerok.startListening();
      await ctx.parallel('bot/init');
      await ctx.parallel('bot/ready');
      log.info(
        `PlayerOK Universal готов к работе (аккаунт: ${account.username}, режим: ${ctx.playerok.isDryRun ? 'DRY-RUN' : ctx.playerok.transport.kind})`,
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

      const log = ctx.logger('universal');
      log.info(`Запуск PlayerOK Universal v${VERSION} (Cordis 4 + TypeScript)`);

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
          recheckTimer = setInterval(() => {
            const current = ctx.playerok.setupProblem;
            if (!current || !current.transient) return;
            void launchPlayerok();
          }, interval);
          recheckTimer.unref?.();
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
