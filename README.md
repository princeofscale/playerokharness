# PlayerOK Universal v2 (TypeScript + Cordis 4)

Полноценная модульная TypeScript-реализация **PlayerOK Universal**, построенная на **Cordis 4** («всё — плагин», DI, типизированные события и обратимые эффекты) + **grammY** + **Zod**.

Подробная карта готовности и архитектурный журнал: [`PROGRESS.md`](./PROGRESS.md).

## Быстрый старт

```bash
cd v2
pnpm install
pnpm build
pnpm test
```

## Перенос настроек из Python-версии (v1) и запуск

Исходные файлы Python-бота (`../bot_settings/`, `../bot_data/`) при миграции **не изменяются**:

```bash
cd v2
node packages/app/dist/cli.js migrate-v1 --from .. --data-dir .
node packages/app/dist/cli.js doctor --data-dir .
node packages/app/dist/cli.js start --data-dir .
```

## Все команды CLI

```bash
# Диагностика окружения, конфига и ключей
node packages/app/dist/cli.js doctor

# Интерактивная первичная настройка (Telegram token, Cloudflare Worker URL, proxy, cookies)
node packages/app/dist/cli.js setup

# Безопасная end-to-end симуляция (сообщение -> !продавец -> сделка -> авто-выдача/подтверждение/восстановление)
node packages/app/dist/cli.js start --simulate --plugins-dir ./plugins-example

# Запуск в режиме DRY-RUN (с Mock-адаптером PlayerOK и реальным Telegram-ботом)
node packages/app/dist/cli.js start --dry-run

# Список установленных внешних плагинов
node packages/app/dist/cli.js plugins

# Рабочий запуск (при ошибке подключения к PlayerOK автоматически включает Setup Mode в Telegram)
node packages/app/dist/cli.js start
```

## Скрипты запуска

- **Linux (Ubuntu / systemd + команда `pluniversal2`)**: `./scripts/install.sh`
- **macOS**: двойной клик по `scripts/start_mac.command`
- **Windows**: `scripts\start.bat`

## Написание внешнего плагина

Положите `.mjs` / `.js` файл в `plugins/` (или отправьте его прямо в Telegram через меню **🔌 Плагины → ➕ Установить плагин**). Плагин проверяется в изолированном процессе и может включаться/выключаться на лету через Cordis `fiber.dispose()`. Пример: [`plugins-example/hello-plugin.mjs`](./plugins-example/hello-plugin.mjs).
