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
} from '@pkh/core';
import { createApplication, runDryRunSimulation } from './bootstrap.js';

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let command = 'start';
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') && i === 0) {
      command = arg;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    }
  }
  return { command, flags };
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
  console.log('');
  await ctx.fiber.dispose();
}

async function runPluginsList(dataDir: string, pluginsDir?: string): Promise<void> {
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
  let copied = 0;

  for (const folder of folders) {
    const srcFolder = path.join(srcRoot, folder);
    if (!fs.existsSync(srcFolder)) continue;
    const dstFolder = path.join(dataDir, folder);
    fs.mkdirSync(dstFolder, { recursive: true });

    for (const file of fs.readdirSync(srcFolder)) {
      if (!file.endsWith('.json')) continue;
      fs.copyFileSync(path.join(srcFolder, file), path.join(dstFolder, file));
      copied += 1;
    }
  }

  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: dataDir });
  ctx.storage.getConfig();
  ctx.storage.getMessages();
  ctx.storage.getBlacklist();
  await ctx.fiber.dispose();

  console.log(`✅ Импорт завершён: скопировано и проверено JSON-файлов: ${copied} (${srcRoot} -> ${dataDir})`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);
  if (flags.help) {
    printHelp();
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
    await runPluginsList(dataDir, pluginsDir);
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

  const app = await createApplication({
    dataDir,
    pluginsDir,
    dryRun,
    enableTelegram,
    enableTimers: !simulate,
    enableInstanceLock: !simulate,
  });

  const shutdown = async (signal: string) => {
    app.ctx.logger('pkh').info(`Получен сигнал ${signal}, завершаю работу...`);
    await app.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

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
