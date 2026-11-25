# PlayerOK Harness (`pkh`) — Статус проекта

## Раунд 2026-11-25 — четырёхсторонний code review

Независимое ревью четырьмя агентами (core / adapter / automation+retry / telegram+app),
каждый правил только свою пакетную директорию. Найдено и исправлено:

- **P0**: Zod 4 `.default()` не валидирует значение по умолчанию (`playerok: {}` в
  `BotConfig`) → `.prefault()`; unhandled rejection из `setInterval(() => void this.tick())`
  в трёх плагинах автоматизации и в maintenance-цикле адаптера → `safeInterval`;
  гонка в `LockService` (два процесса могли взять один lock) → `O_EXCL`;
  выход `removePlugin` / `resolvePath` за пределы рабочей директории → containment guard.
- **P1**: обход изоляции untrusted-плагинов через `ctx.get('storage')`; доступ к store
  `idempotency` (guard от двойной выдачи); утечка токена в `cfg:export`; потеря catch-up
  окна при реконнекте WS; сломанный `reconfigureTransport()` после Setup Mode; повтор
  неидемпотентного `createChatMessage`; двойное выполнение задач в retry-queue; неверный
  ре-фетч товара в `auto-restore`; утечка `subscribedChatIds`; `answerCallbackQuery`.
- **P2**: `safeInterval` стал single-flight; ограниченное хранение `cached_orders`,
  `bumped_items` и idempotency-маркеров (30 дней вместо FIFO на 5000); неизвестный `kind`
  в retry-queue больше не уходит в DLQ с первого прохода.

Добавлены type-aware ESLint (`no-floating-promises`, `no-misused-promises`,
`await-thenable`) для `packages/*/src`, `test/regressions.test.ts` (6 тестов на каждый
исправленный класс дефектов) и `docs/ROADMAP.md` с планом развития.

Проверка: `pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm test` — **46/46**.

---

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

## Раунд 2 (2026-11-25) — новый функционал

- **@pkh/plugin-web**: read-only дашборд без зависимостей (node:http + SSE): обзор,
  сделки, очередь повторов/DLQ, хвост логов, /api/*, /events, /healthz; токен через
  PKH_WEB_TOKEN или --web-token; отказ стартовать на не-loopback адресе без токена.
  Подключён в createApplication (--web, PKH_WEB_*) с ожиданием готовности сервера.
- **Контракт-гард PlayerOK**: 13 loose-Zod схем ответов GraphQL/WS, 14 точек проверки,
  кольцевой буфер ContractIssue (50), PlayerokService.getContractIssues() и watchdog в
  bootstrap, который пишет в лог появившийся дрейф API.
- **Retry-queue**: персистентные lease-ы (pending/processing/dead, claimedAt/claimedBy),
  реклейм просроченной аренды, retention DLQ (14 дней / 500 задач), джиттер ±20 %,
  валидация статуса в update_deal.
- **Автоматизация**: поиск проданного товара по id, возврат ключа в сток при отказе
  очереди, эскалация !продавец в первом сообщении, честная ошибка баланса,
  экранирование URL в уведомлениях.
- **Конфиг**: env-оверрайды больше не мутируют объект и не могут попасть в config.json
  через setConfig(getConfig()).
- **Тулинг**: pretest собирает workspace, CI делает холодную сборку (pnpm clean).

## Раунд 3 (2026-11-25) — аналитика, контракты мутаций, устойчивый SSE

- **@pkh/plugin-analytics**: постоянная статистика продаж в bot_data/analytics.json —
  дневные корзины (оборот/заказы/подтверждено/возвраты), топ товаров, идемпотентный
  бэкфилл из кэша сделок, календарные окна день/неделя/месяц, retention 400 дней.
- **Контракт-гард мутаций**: 9 loose-схем на все вызываемые GraphQL-мутации; дрейф поля
  пишется в ContractIssue, а не превращается в undefined. Загрузка изображения теперь
  падает с понятной ошибкой вместо null-deref.
- **Дашборд**: страница /analytics и /api/analytics из кэша сделок, SSE с id кадров,
  кольцевой буфер на 200 событий и реплей по Last-Event-ID, heartbeat 15 с.
- **Ядро**: логи ротируются в latest.log.1/.2 вместо обнуления, чтение только хвоста,
  просроченные заявки на доступ чистятся с диска, восстановление битого хранилища
  репортится один раз (лог + boot-report) вместо тихого сброса.
- **Панель**: экран статистики показывает топ-5 товаров по выручке за период.
- **Ops**: pkh doctor показывает очередь/DLQ, незавершённый boot-маркер и статус
  дашборда; CI собирает «на холодную», прогоняет CLI smoke и тайпчекает тесты.
