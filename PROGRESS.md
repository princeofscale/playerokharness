# PlayerOK Harness (`pkh`) — Статус проекта

**Репозиторий:** https://github.com/princeofscale/playerokharness  
**Стек:** TypeScript 5 · Cordis 4 · grammY · Zod · Vitest · ESLint · GitHub Actions

---

## Текущий статус: ✅ Production-Ready v1.0.0

| Пакет | Назначение | Статус |
|---|---|---|
| `@pkh/core` | Ядро Cordis 4: типы/энамы, типизированная шина событий, `StorageService` (атомарный JSON + per-store mutex `runExclusive` + `idempotency` + `PKH_*` env overrides + Zod), `LogSinkService` (секрет-редакция + ротация), `LockService`, `AccessService`, `BlacklistService`, `BootReportService`, `UpdaterService`, `PluginManagerService` (subprocess-проверка + откат + hot dispose) | ✅ Готово |
| `@pkh/adapter` | `PlayerokService` (с поштучной изоляцией ошибок слушателей), `MockPlayerokTransport` (`--dry-run`), `GraphQLPlayerokTransport` (HTTP APQ, multipart upload, proxy, `graphql-transport-ws`, `catchUpMessages`, `pollNewDeals`, `pollPendingReviews`, `diagnose`) | ✅ Готово |
| `@pkh/plugin-automation` | 9 независимых Cordis-плагинов с `try/catch`, идемпотентностью и сериализацией записей (orders-cache, blacklist, messages, auto-delivery, auto-complete, auto-restore + data_replacement + recreate, auto-bump день/ночь, auto-withdrawal, notifications) | ✅ Готово |
| `@pkh/plugin-telegram` | Telegram-интерфейс на `grammY`: прокси + Cloudflare Workers `apiRoot`, плавающее меню, Setup Mode, отчёты запуска, пагинация и фильтры, полное редактирование всех настроек/привязок/поштучных товаров/замены данных/реквизитов вывода, отправка фото в чаты, установка `.mjs/.js` плагинов, экран обновлений, `addComposer()` | ✅ Готово |
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
- [x] **Документация**: переработанный `README.md`, `AGENTS.md`, `LICENSE` (MIT).
