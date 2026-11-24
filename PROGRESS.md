# PlayerOK Universal v2 (TypeScript + Cordis 4) — Прогресс разработки

Этот файл отслеживает статус полного переноса **PlayerOK Universal** на новую архитектуру **TypeScript + Cordis 4 + grammY + Zod** (принцип «всё — плагин», DI, типизированные события, обратимые эффекты).

Исходный Python-бот в корне репозитория (`bot.py`, `bot_settings/`, `bot_data/`) **не изменяется** — вся новая версия живёт изолированно в `v2/`.

---

## Статус: ✅ Полный перенос архитектуры завершён (5 пакетов, 21/21 автотестов, все CLI и скрипты запуска готовы)

| Пакет | Назначение | Статус |
|---|---|---|
| `@playerok/core` | Ядро на Cordis 4: типы/энамы, типизированные события, атомарное JSON-хранилище (`StorageService` + Zod), лог-синк (`LogSinkService`), PID-локи (`LockService`), доступ (`AccessService`), ЧС (`BlacklistService`), отчёты запуска (`BootReportService`), проверка релизов (`UpdaterService`), менеджер плагинов (`PluginManagerService` с проверкой в дочернем процессе и откатом), утилиты (шаблонизатор, привязки, день/ночь, валидаторы) | ✅ 100% готово |
| `@playerok/adapter` | `PlayerokService` + `MockPlayerokTransport` (`--dry-run`) + `GraphQLPlayerokTransport` (точные persisted-query SHA-256 хеши и GraphQL-мутации/подписки PlayerOK, multipart-загрузка изображений, HTTP-прокси `undici`/`HttpsProxyAgent`, WS `chatMessageCreated`/`chatUpdated`/`userUpdated`, дедупликация, догон пропущенных сообщений `catchUpMessages`, фоллбэк поллинга сделок, отложенная проверка отзывов `pollPendingReviews`, диагностика и Setup Mode) | ✅ 100% готово |
| `@playerok/plugin-automation` | 9 независимых Cordis-плагинов: кэш заказов/статистика, ЧС (+ авто-возврат), авто-ответы/`!продавец`/кастомные команды, авто-выдача (поштучная и сообщением), авто-подтверждение, авто-восстановление (+ замена данных + пересоздание с переносом изображений + перепривязка), авто-поднятие (интервал/позиция со streak ≥ 2 + ночной режим), авто-вывод (Карта/СБП/USDT), маршрутизация уведомлений | ✅ 100% готово |
| `@playerok/plugin-telegram` | Полноценный Telegram-бот на `grammY`: кастомный `apiRoot` (Cloudflare Workers) + HTTP-прокси, плавающее меню, Setup Mode, отчёты о загрузке, авторизация (`owner_`, legacy-пароль, заявки на доступ), пагинация и фильтры всех списков, полное редактирование всех параметров/привязок/поштучных товаров/замены данных/реквизитов вывода прямо из Telegram, отправка фото в чаты PlayerOK, установка `.mjs/.js` плагинов прямо из Telegram с проверкой и откатом, экран обновлений | ✅ 100% готово |
| `@playerok/app` | Bootstrap + Setup Mode с авто-перепроверкой, CLI (`start`, `setup`, `doctor`, `plugins`, `migrate-v1`, `--dry-run`, `--simulate`, `--no-telegram`), скрипты запуска/установки для Linux (`systemd`), macOS и Windows, пример внешнего плагина | ✅ 100% готово |

---

## Выполненный чеклист (все фазы)

### 1. Ядро и сервисы (`@playerok/core`)
- [x] Монорепозиторий `pnpm` + строгий TypeScript (`tsconfig.base.json`) + `vitest`
- [x] Полные TypeScript-модели и энамы PlayerOK (включая `SbpBankMember`, `VerifiedCard`, `SetupProblem`, `BootError`, `GitHubRelease`)
- [x] Типизированная шина событий Cordis (`declare module 'cordis'`)
- [x] `StorageService`: атомарная запись (`tmp` + `fsync` + `rename`), `.bak` при битом JSON, Zod-валидация и авто-восстановление ключей для всех 18 файлов настроек и данных, `rebindItem`, `exportSnapshot`
- [x] `LogSinkService`: нативный `ctx.logger.exporter(...)` Cordis 4, цветной вывод, `logs/latest.log` с контролем размера
- [x] `LockService`: защита от двойного запуска инстанса и одного аккаунта
- [x] `AccessService` и `BlacklistService`
- [x] `BootReportService`: маркеры перезапуска/настройки, объяснение ошибок, HTML-отчёт запуска
- [x] `UpdaterService`: проверка релизов GitHub с кэшированием, сравнение версий и событие `update/available`
- [x] `PluginManagerService`: динамическая загрузка, вкл/выкл на лету через `fiber.dispose()`, установка файлов плагинов с проверкой в изолированном дочернем процессе Node и автоматическим откатом при ошибке

### 2. Интеграция PlayerOK (`@playerok/adapter`)
- [x] Точные `PERSISTED_QUERIES` SHA-256 хеши и `GQL_QUERIES` мутации/подписки (перенесены из `playerokapi/misc.py`)
- [x] `MockPlayerokTransport` для `--dry-run`, симуляции и автотестов
- [x] `GraphQLPlayerokTransport`:
  - [x] `GET /graphql` (Apollo APQ persisted queries) и `POST /graphql` (мутации)
  - [x] Multipart GraphQL upload (`uploadChatImageIntoTemporaryStore`, вложения в `createItem`) и `downloadFile`
  - [x] HTTP-прокси для `fetch` (`undici.ProxyAgent`) и `WebSocket` (`HttpsProxyAgent`)
  - [x] WS-подписки `userUpdated`, `chatUpdated`, `chatMessageCreated`, ping/pong, экспоненциальный реконнект
  - [x] Догон пропущенных сообщений после обрыва WS (`catchUpMessages`)
  - [x] Фоллбэк-поллинг новых сделок (`pollNewDeals`) и отложенная проверка отзывов (`pollPendingReviews`)
  - [x] Методы `getSbpBankMembers`, `getVerifiedCards`, `markChatAsRead`, `removeTransaction`, `reportDealProblem`
  - [x] Явная диагностика `BotCheckDetectedError` / `UnauthorizedError` (без обхода антибот-защит)
- [x] `PlayerokService.diagnose()` + `reconfigureTransport()` + живой выход из Setup Mode без перезапуска процесса

### 3. Бизнес-логика (`@playerok/plugin-automation`)
- [x] `ordersCachePlugin` + `computeOrdersStats` (24ч / неделя / месяц / всё время)
- [x] `blacklistPlugin` (перехват сделок из ЧС + опциональный авто-возврат)
- [x] `messagesPlugin` (приветствие, шаблоны всех событий, `!продавец`/`!seller`, кастомные команды)
- [x] `autoDeliveryPlugin` (поштучная с атомарным списанием и статичное сообщение)
- [x] `autoCompletePlugin` (`all` + `included`/`excluded`)
- [x] `AutoRestoreService` (проданные/истёкшие, `free`/`premium`/`publish_status`, `data_replacement`, `recreate` с переносом изображений, перепривязкой конфигов и откатом черновика при ошибке)
- [x] `AutoBumpService` (режимы `interval` и `position` со streak ≥ 2, кулдауном, днём/ночью и очисткой истории)
- [x] `AutoWithdrawalService` (Карта РФ / СБП / USDT, порог > 500₽)
- [x] `notificationsPlugin` (все флаги `notifications.events` + интерактивные кнопки)

### 4. Telegram-интерфейс (`@playerok/plugin-telegram`)
- [x] `TelegramService` на `grammY` с поддержкой кастомного `apiRoot` (Cloudflare Workers) и HTTP-прокси
- [x] Плавающее меню (`floatMessageIds`), отчёты запуска (`sendBootReport`), Setup Mode UI (`renderSetupMode`)
- [x] Авторизация (`owner_` deep-link, legacy-пароль, заявки с 24ч кулдауном)
- [x] Пагинация и фильтры для Чатов, Сделок, Товаров, Отзывов, Транзакций, Авто-выдачи, Замены данных, Привязок и ЧС
- [x] Полное inline/FSM-редактирование всех настроек: интервалы/позиции/ночь авто-поднятия, привязки товаров по ссылке PlayerOK/ID/фразе, поштучные товары и строки замены данных (текст или `.txt` файл), реквизиты авто-вывода (выбор карты / банка СБП / USDT), параметры подключения (cookies/UA/proxy/timeout/API URL/chat_id)
- [x] Отправка фото из Telegram прямо в чат PlayerOK (`message:photo`)
- [x] Установка (`.mjs`/`.js`) и удаление внешних плагинов прямо из Telegram с изолированной проверкой и откатом
- [x] Экран обновлений (GitHub Releases) и выгрузка снимка конфигов документом
- [x] API для сторонних плагинов: `ctx.telegram.addComposer(composer)`

### 5. CLI, скрипты развёртывания и верификация (`@playerok/app`, `v2/scripts/`, `v2/test/`)
- [x] CLI: `start`, `setup`, `doctor`, `plugins`, `migrate-v1` (проверена миграция реальных 16 JSON-файлов из Python v1!)
- [x] Скрипты установки/запуска: `v2/scripts/install.sh` (Linux + `systemd` + `pluniversal2`), `v2/scripts/start_mac.command`, `v2/scripts/start.bat`
- [x] Тесты: **5 тестовых файлов, 21 тест — все пройдены** (`core`, `graphql-transport` с локальным HTTP/WS сервером, `automation`, `lifecycle-and-plugins` с Setup Mode и subprocess-проверкой плагинов, `telegram`)

---

## Примечание перед боевым запуском

- В `GraphQLPlayerokTransport` используются стандартные HTTP/WebSocket-запросы (без обхода Cloudflare / DDoS-Guard). Если PlayerOK вернёт антибот-проверку (`BotCheckDetectedError`), бот не упадёт, а перейдёт в **Setup Mode** и сообщит об этом в Telegram.
- Для переноса ваших текущих настроек из Python-версии выполните в папке `v2/`:
  ```bash
  node packages/app/dist/cli.js migrate-v1 --from .. --data-dir .
  node packages/app/dist/cli.js doctor --data-dir .
  node packages/app/dist/cli.js start --data-dir .
  ```

---

## Журнал выполненных шагов

- **2026-11-24 (Сессия 1)** — Аудит v1, создание монорепозитория `v2/`, реализация 5 пакетов (Cordis 4 + TypeScript + grammY + Zod), 14 базовых тестов.
- **2026-11-24 (Сессия 2)** — Доведение до 100% полноценного рабочего приложения:
  - Добавлены `BootReportService`, `UpdaterService` и безопасная установка плагинов с проверкой в дочернем процессе и откатом.
  - Перенесены реальные `PERSISTED_QUERIES` и `GQL_QUERIES` PlayerOK, добавлены multipart-загрузка изображений, HTTP-прокси (`undici` / `HttpsProxyAgent`), WS `chatMessageCreated` + `catchUpMessages` + `pollNewDeals` + `pollPendingReviews`, `getSbpBankMembers` / `getVerifiedCards`, диагностика и Setup Mode.
  - Расширен Telegram UI до полного паритета: плавающее меню, Setup Mode, пагинация и фильтры, редактирование всех настроек/привязок/поштучных товаров/замены данных/реквизитов вывода/подключения, отправка фото в чаты, установка `.mjs/.js` плагинов и экран обновлений.
  - Созданы скрипты запуска для Linux (`systemd`), macOS и Windows.
  - Пройдены `pnpm build`, `pnpm typecheck`, **21/21 тестов**, `migrate-v1` (16 реальных JSON-файлов), `doctor` и `start --simulate`.
