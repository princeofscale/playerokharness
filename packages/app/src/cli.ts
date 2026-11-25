#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  AccessService,
  Context,
  isCookiesValid,
  isProxyValid,
  isTgTokenValid,
  normalizeCustomApiUrl,
  StorageService,
  VERSION,
  type BootMarker,
} from '@pkh/core';
import { createApplication, runDryRunSimulation } from './bootstrap.js';

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  problems: string[];
}

/** Флаги, которым требуется значение. Всё, что не перечислено, считается опечаткой. */
const VALUE_FLAGS = new Set(['data-dir', 'plugins-dir', 'from', 'web-port', 'web-host', 'web-token']);
const BOOLEAN_FLAGS = new Set(['dry-run', 'simulate', 'no-telegram', 'web', 'help']);

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let command = 'start';
  let commandSeen = false;
  const flags: Record<string, string | boolean> = {};
  const problems: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith('-')) {
      // Команда — первый позиционный аргумент; флаги могут стоять до неё.
      if (commandSeen) problems.push(`лишний аргумент «${arg}»`);
      else {
        command = arg;
        commandSeen = true;
      }
      continue;
    }
    if (!arg.startsWith('--')) {
      problems.push(`неизвестный флаг «${arg}»`);
      continue;
    }
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) {
      // Опечатка вроде --dryrun не должна молча запускать бота в реальном режиме
      problems.push(`неизвестный флаг «${arg}»`);
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith('-')) {
      problems.push(`флаг «${arg}» требует значение`);
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return { command, flags, problems };
}

function printHelp(): void {
  console.log(`
PlayerOK Harness (pkh) v${VERSION} — Cordis 4 + TypeScript

Использование:
  pkh [команда] [флаги]

Команды:
  start          Запустить PlayerOK Harness (по умолчанию)
  setup          Интерактивная настройка токена Telegram, прокси и cookies PlayerOK
  doctor         Диагностика конфигурации, переменных окружения и готовности к запуску
  plugins        Показать установленные внешние плагины в папке plugins/
  import-config  Импортировать JSON-настройки и данные из внешнего каталога (--from <путь>)

Флаги:
  --dry-run            Запуск с MockPlayerokTransport без реальных сетевых запросов
  --simulate           Выполнить демо-сценарий событий в режиме --dry-run и завершиться
  --no-telegram        Не запускать Telegram-бота
  --web                Поднять локальный read-only дашборд (по умолчанию 127.0.0.1:8787)
  --web-port <порт>    Порт дашборда (или PKH_WEB_PORT)
  --web-host <хост>    Адрес дашборда; не-loopback требует токен
  --web-token <токен>  Токен доступа к дашборду (или PKH_WEB_TOKEN)
  --data-dir <путь>    Каталог для bot_settings/, bot_data/, logs/, plugins/
  --plugins-dir <путь> Каталог внешних плагинов
  --from <путь>        Исходный каталог для команды import-config
  -h, --help           Показать справку
`);
}

async function runSetup(dataDir: string): Promise<void> {
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: dataDir });
  await ctx.use(AccessService);

  const rl = readline.createInterface({ input, output });
  try {
    console.log(`\n⚙️ Первичная настройка PlayerOK Harness (pkh) v${VERSION} (${dataDir})\n`);
    const cfg = ctx.storage.getConfig();

    const token = (await rl.question(`Telegram Bot Token [${cfg.telegram.api.token ? 'задан' : 'пусто'}]: `)).trim();
    if (token) {
      if (!isTgTokenValid(token)) {
        console.log('⚠️ Формат токена не похож на стандартный Telegram Bot Token, сохраняю как есть.');
      }
      cfg.telegram.api.token = token;
    }

    const customApi = (
      await rl.question(
        `Кастомный Telegram API URL / Cloudflare Worker (Enter чтобы пропустить) [${cfg.telegram.api.custom_api_url || 'нет'}]: `,
      )
    ).trim();
    if (customApi) {
      cfg.telegram.api.custom_api_url = normalizeCustomApiUrl(customApi);
    }

    const tgProxy = (
      await rl.question(`Прокси для Telegram (ip:port или user:pass@ip:port, Enter пропуск) [${cfg.telegram.api.proxy || 'нет'}]: `)
    ).trim();
    if (tgProxy) {
      if (!isProxyValid(tgProxy)) console.log('⚠️ Нестандартный формат прокси.');
      cfg.telegram.api.proxy = tgProxy;
    }

    const cookies = (
      await rl.question(`PlayerOK Cookies (Enter чтобы пропустить или оставить текущие): `)
    ).trim();
    if (cookies) {
      if (!isCookiesValid(cookies)) console.log('⚠️ Строка cookies выглядит некорректно.');
      cfg.playerok.api.cookies = cookies;
    }

    ctx.storage.setConfig(cfg);
    const ownerCode = ctx.access.getOwnerCode();
    console.log(`\n✅ Конфигурация сохранена в ${ctx.storage.getStorePath('config')}`);
    console.log(`🔑 Одноразовый код владельца: owner_${ownerCode}`);
    console.log('   Передайте его боту командой /start owner_<код> после запуска.\n');
  } finally {
    rl.close();
    await ctx.fiber.dispose();
  }
}

async function runDoctor(dataDir: string): Promise<void> {
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: dataDir });
  const cfg = ctx.storage.getConfig();

  const checks: Array<[string, boolean, string]> = [
    ['Node.js >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.version],
    ['Каталог данных', fs.existsSync(dataDir), dataDir],
    ['Telegram Token', isTgTokenValid(cfg.telegram.api.token), cfg.telegram.api.token ? 'валидный формат' : 'не задан'],
    ['PlayerOK Cookies', isCookiesValid(cfg.playerok.api.cookies), cfg.playerok.api.cookies ? 'валидный формат' : 'не заданы (используйте --dry-run для теста)'],
    ['Владельцы Telegram', cfg.telegram.bot.signed_users.length > 0, `авторизовано: ${cfg.telegram.bot.signed_users.length}`],
  ];

  console.log(`\n🩺 Диагностика PlayerOK Harness (pkh) v${VERSION}\n`);
  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? '✅' : '⚠️'} ${label}: ${detail}`);
  }

  // Operational state that an operator needs before a restart, read without booting.
  const queue = readQueueStats(dataDir);
  if (queue) {
    console.log(
      `  ${queue.dead > 0 ? '⚠️' : '✅'} Очередь повторов: ожидает ${queue.pending}, в Dead-Letter ${queue.dead}`,
    );
  }
  const markers = ctx.storage.get<{ action?: string }>('boot_marker');
  if (markers?.action) {
    console.log(`  ⚠️ Boot-маркер: «${markers.action}» (прошлый запуск не завершился штатно)`);
  }
  const webPort = process.env.PKH_WEB_PORT ?? '8787';
  const webOn = ['1', 'true', 'yes', 'on'].includes((process.env.PKH_WEB_ENABLED ?? '').toLowerCase());
  const webToken = Boolean(process.env.PKH_WEB_TOKEN);
  console.log(
    `  ${webOn ? '✅' : '⚠️'} Веб-панель: ${webOn ? `включена (порт ${webPort})` : 'выключена (--web или PKH_WEB_ENABLED=true)'}${webOn && !webToken ? ' — токен не задан, только loopback' : ''}`,
  );
  console.log('');
  await ctx.fiber.dispose();
}

/** Reads bot_data/retry_queue.json without booting the app (doctor must stay offline). */
function readQueueStats(dataDir: string): { pending: number; dead: number } | null {
  try {
    const file = path.join(dataDir, 'bot_data', 'retry_queue.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      tasks?: Array<{ status?: string }>;
    };
    const tasks = parsed.tasks ?? [];
    let dead = 0;
    for (const task of tasks) {
      if (task.status === 'dead') dead += 1;
    }
    return { pending: tasks.length - dead, dead };
  } catch {
    return null;
  }
}

function runPluginsList(dataDir: string, pluginsDir?: string): void {
  const targetDir = path.resolve(pluginsDir ?? path.join(dataDir, 'plugins'));
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  console.log(`\n🔌 Плагины pkh в ${targetDir}:\n`);
  const filtered = entries.filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules');
  if (filtered.length === 0) {
    console.log('  (пусто — поместите .mjs/.js файл или папку с index.mjs)');
  } else {
    for (const e of filtered) {
      console.log(`  • ${e.name}${e.isDirectory() ? '/' : ''}`);
    }
  }
  console.log('');
}

async function runImportConfig(fromDir: string, dataDir: string): Promise<void> {
  const srcRoot = path.resolve(fromDir);
  if (!fs.existsSync(srcRoot)) {
    throw new Error(`Исходный каталог не найден: ${srcRoot}`);
  }

  const folders = ['bot_settings', 'bot_data'];
  // Копия текущих файлов: неудачный импорт (невалидный JSON/Zod) не должен уничтожать рабочий конфиг —
  // StorageService при чтении битого файла перезаписывает .bak именно битым содержимым.
  const backupRoot = path.join(
    dataDir,
    `import-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  let copied = 0;
  let backedUp = 0;

  for (const folder of folders) {
    const srcFolder = path.join(srcRoot, folder);
    if (!fs.existsSync(srcFolder)) continue;
    const dstFolder = path.join(dataDir, folder);
    fs.mkdirSync(dstFolder, { recursive: true });

    for (const file of fs.readdirSync(srcFolder)) {
      if (!file.endsWith('.json')) continue;
      const dstPath = path.join(dstFolder, file);
      if (fs.existsSync(dstPath)) {
        const backupFolder = path.join(backupRoot, folder);
        fs.mkdirSync(backupFolder, { recursive: true });
        fs.copyFileSync(dstPath, path.join(backupFolder, file));
        backedUp += 1;
      }
      fs.copyFileSync(path.join(srcFolder, file), dstPath);
      copied += 1;
    }
  }

  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: dataDir });
  ctx.storage.getConfig();
  ctx.storage.getMessages();
  ctx.storage.getBlacklist();
  await ctx.fiber.dispose();

  console.log(
    `✅ Импорт завершён: скопировано и проверено JSON-файлов: ${copied} (${srcRoot} -> ${dataDir})` +
      (backedUp > 0 ? `\n💾 Резервная копия прежних файлов: ${backupRoot}` : ''),
  );
}

async function main(): Promise<void> {
  const { command, flags, problems } = parseArgs(process.argv);
  if (flags.help) {
    printHelp();
    return;
  }
  if (problems.length > 0) {
    console.error(`Некорректные аргументы командной строки:\n  - ${problems.join('\n  - ')}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const dataDir = path.resolve(
    typeof flags['data-dir'] === 'string'
      ? flags['data-dir']
      : process.env.PKH_DATA_DIR || process.cwd(),
  );
  const pluginsDir =
    typeof flags['plugins-dir'] === 'string'
      ? flags['plugins-dir']
      : process.env.PKH_PLUGINS_DIR || undefined;

  if (command === 'setup') {
    await runSetup(dataDir);
    return;
  }
  if (command === 'doctor') {
    await runDoctor(dataDir);
    return;
  }
  if (command === 'plugins') {
    runPluginsList(dataDir, pluginsDir);
    return;
  }
  if (command === 'import-config') {
    const fromDir = typeof flags.from === 'string' ? flags.from : '';
    if (!fromDir) {
      throw new Error('Укажите исходный каталог через --from <путь>');
    }
    await runImportConfig(fromDir, dataDir);
    return;
  }

  if (command !== 'start') {
    console.error(`Неизвестная команда: ${command}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const dryRun = Boolean(flags['dry-run'] || flags.simulate);
  const simulate = Boolean(flags.simulate);
  const enableTelegram = !flags['no-telegram'] && !simulate;

  const webPortRaw = typeof flags['web-port'] === 'string' ? Number(flags['web-port']) : undefined;
  if (webPortRaw !== undefined && (!Number.isInteger(webPortRaw) || webPortRaw < 0 || webPortRaw > 65535)) {
    console.error(`Некорректный --web-port: ${String(flags['web-port'])}`);
    process.exitCode = 1;
    return;
  }

  const app = await createApplication({
    dataDir,
    pluginsDir,
    dryRun,
    enableTelegram,
    enableTimers: !simulate,
    enableInstanceLock: !simulate,
    enableWeb: Boolean(flags.web),
    webHost: typeof flags['web-host'] === 'string' ? flags['web-host'] : undefined,
    webPort: webPortRaw,
    webToken: typeof flags['web-token'] === 'string' ? flags['web-token'] : undefined,
  });

  const dashboard = app.ctx.get('webDashboard', false);
  if (dashboard?.address) {
    const shown = dashboard.address.host === '0.0.0.0' ? '127.0.0.1' : dashboard.address.host;
    app.ctx
      .logger('pkh')
      .info(`Дашборд: http://${shown}:${dashboard.address.port}/ (read-only, нужен токен)`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const log = app.ctx.logger('pkh');
    log.info(`Получен сигнал ${signal}, завершаю работу...`);
    try {
      await app.stop();
    } catch (err) {
      log.error(`Ошибка при остановке: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // Команда /restart в Telegram: сервис ставит boot-marker и шлёт 'bot/shutdown'.
  // Завершаем процесс, чтобы супервизор (systemd Restart=always / start_mac.command)
  // поднял его снова, а отчёт о запуске отредактировал то же сообщение.
  // Обычные остановки (SIGINT/SIGTERM, simulate) маркера 'restart' не имеют.
  app.ctx.on('bot/shutdown', () => {
    const marker = app.ctx.storage.get<BootMarker>('boot_marker');
    if (marker?.action !== 'restart') return;
    void shutdown('telegram /restart');
  });

  await app.start();

  if (simulate) {
    await runDryRunSimulation(app.ctx);
    await app.stop();
  }
}

main().catch((err) => {
  console.error('❌ Фатальная ошибка:', err instanceof Error ? err.message : err);
  process.exit(1);
});
