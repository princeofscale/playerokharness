# PlayerOK Harness (`pkh`) — Статус проекта

**Репозиторий:** https://github.com/princeofscale/playerokharness  
**Стек:** TypeScript 5 · Cordis 4 · grammY · Zod · Vitest · ESLint · GitHub Actions

---

## Текущий статус: ✅ Production-Ready v1.0.0

| Пакет | Назначение | Статус |
|---|---|---|
| `@pkh/core` | Ядро Cordis 4: типы/энамы, типизированная шина событий, `StorageService` (атомарный JSON + per-store mutex `runExclusive` + `idempotency` + `PKH_*` env overrides + Zod), `LogSinkService` (секрет-редакция + ротация), `LockService`, `AccessService`, `BlacklistService`, `BootReportService`, `UpdaterService`, `PluginManagerService` (subprocess-проверка + откат + hot dispose) | ✅ Готово |
| `@pkh/adapter` | `PlayerokService` (с поштучной изоляцией ошибок слушателей), `MockPlayerokTransport` (`--dry-run`), `GraphQLPlayerokTransport` (HTTP APQ, multipart upload, proxy, `graphql-transport-ws`, `catchUpMessages`, `pollNewDeals`, `pollPendingReviews`, `diagnose`) | ✅ Готово |
| `@pkh/plugin-retry-queue` | Персистентная очередь повторов (`bot_data/retry_queue.json`) с экспоненциальным backoff, дедупликацией (`dedupeKey`), Dead-Letter Queue (DLQ), алертами `notify/log` и встроенными обработчиками `send_message`, `update_deal`, `publish_item`, `bump_item` | ✅ Готово |
| `@pkh/plugin-automation` | 9 независимых Cordis-плагинов с `try/catch`, идемпотентностью, сериализацией записей и автоматическим fallback в `retryQueue` (orders-cache, blacklist, messages, auto-delivery, auto-complete, auto-restore + data_replacement + recreate, auto-bump день/ночь, auto-withdrawal, notifications) | ✅ Готово |
| `@pkh/plugin-telegram` | Telegram-интерфейс на `grammY`: прокси + Cloudflare Workers `apiRoot`, плавающее меню, Setup Mode, отчёты запуска, пагинация и фильтры, полное редактирование всех настроек/привязок/поштучных товаров/замены данных/реквизитов вывода, экран очереди повторов и DLQ, отправка фото в чаты, установка `.mjs/.js` плагинов, экран обновлений, `addComposer()` | ✅ Готово |
| `@pkh/app` | Bootstrap + Setup Mode с авто-перепроверкой и CLI `pkh` (`start`, `setup`, `doctor`, `plugins`, `import-config`) + скрипты запуска Linux/macOS/Windows | ✅ Готово |

---

## Чеклист инженерного качества (по аудиту)

- [x] **Брендинг `PlayerOK Harness` / `pkh`**: все пакеты `@pkh/*`, бинарник `pkh`, systemd-сервис `playerokharness`, zero legacy brand references.
- [x] **CI/CD**: `.github/workflows/ci.yml` (`pnpm lint`, `pnpm build`, `pnpm typecheck`, `pnpm test` на Node 20 и 22).
- [x] **Линтер**: `eslint.config.mjs` (ESLint 10 + `typescript-eslint`), `pnpm lint` проходит чисто.
- [x] **Обработка ошибок и изоляция**: `try/catch` во всех обработчиках событий + поштучная изоляция слушателей в `PlayerokService.dispatchEvent`.
- [x] **Идемпотентность и конкурентность**: `StorageService.runExclusive()` + `bot_data/idempotency.json` (`isDealDelivered` / `isDealCompleted`) защищают от двойной выдачи и гонок записи.
- [x] **Очистка ресурсов без утечек**: все подписки/таймеры/сокеты привязаны к Cordis `Fiber` / `ctx.effect()`, подтверждено тестом многократного `enable`/`disable`.
- [x] **Безопасность конфигурации и логов**: `.env.example` + `PKH_*` env overrides + `redactSecrets()` в `LogSinkService`.
- [x] **Безопасные асинхронные эффекты (P0)**: `safeEffect()` + `safeInterval()` — исключают тихое подавление ошибок в async-эффектах и гарантируют очистку всех таймеров (включая `setupMode:autoRecheck`).
- [x] **Строгая валидация конфигов и обязательных плагинов (P1)**: per-plugin Zod `Config` + `plugins.required` (`verifyRequiredPlugins()`) + строгая валидация `TelegramService` токена до старта.
- [x] **Изоляция прав внешних плагинов (P2)**: capability-ограниченный контекст для недоверенных плагинов (`plugins.trusted`) скрывает секреты и блокирует `autoWithdrawal` / `access` / `lock` / `setConfig`.
- [x] **Персистентная очередь повторов и Dead-Letter Queue (`@pkh/plugin-retry-queue`)**: экспоненциальный backoff, дедупликация задач, резервирование поштучных ключей при сбое `sendMessage`, fallback для `auto-delivery` / `auto-complete` / `blacklist` / `auto-restore` / `auto-bump`, Telegram-экран управления DLQ и алерты.
- [x] **Документация**: переработанный `README.md`, `AGENTS.md`, `LICENSE` (MIT).
