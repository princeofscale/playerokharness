# AGENTS.md — PlayerOK Harness (`pkh`)

This repository is **PlayerOK Harness (`pkh`)** — an independent, plugin-first TypeScript automation harness for PlayerOK built on **Cordis 4**, **grammY**, and **Zod**.

## Workspace Layout

- `packages/core` (`@pkh/core`): Cordis 4 foundation — domain types/enums, typed events (`declare module 'cordis'`), `StorageService` (atomic JSON + per-store mutex + Zod validation + `PKH_*` env overrides + idempotency store), `LogSinkService` (with secret redaction), `LockService`, `AccessService`, `BlacklistService`, `BootReportService`, `UpdaterService`, `PluginManagerService` (dynamic loading, subprocess verification & rollback).
- `packages/playerok` (`@pkh/adapter`): `PlayerokService` + `PlayerokTransport` abstraction (`MockPlayerokTransport` for `--dry-run`/tests, `GraphQLPlayerokTransport` for standard HTTP GraphQL APQ + multipart uploads + `graphql-transport-ws` + catch-up + review polling + proxy).
- `packages/plugin-retry-queue` (`@pkh/plugin-retry-queue`): `RetryQueueService` — persistent retry queue (`bot_data/retry_queue.json`) with exponential backoff, deduplication, Dead-Letter Queue (DLQ), Telegram alerts, and built-in handlers (`send_message`, `update_deal`, `publish_item`, `bump_item`).
- `packages/plugin-automation` (`@pkh/plugin-automation`): 9 independent Cordis automation plugins (orders cache, blacklist, event messages/commands, idempotent auto-delivery, idempotent auto-complete, auto-restore with data replacement & recreate, day/night auto-bump, auto-withdrawal, notifications) with automatic retry-queue fallback on PlayerOK API errors.
- `packages/plugin-telegram` (`@pkh/plugin-telegram`): `TelegramService` on grammY — floating menus, Setup Mode, pagination & filters, full inline/FSM settings management, photo chat replies, live `.mjs/.js` plugin installer, external router injection via `ctx.telegram.addComposer()`.
- `packages/app` (`@pkh/app`): `createApplication` bootstrap (with Setup Mode + auto-recheck) and `pkh` CLI binary (`start`, `setup`, `doctor`, `plugins`, `import-config`).

## Coding & Safety Conventions

1. **Plugin-first**: Every feature is a Cordis 4 `Service` or plugin component declaring explicit `inject = [...]`. Never put business logic in `@pkh/core`.
2. **Error isolation**: Wrap every async `ctx.on(...)` handler in `try/catch` and log via `ctx.logger('<scope>')`. Never let one failing plugin or event crash the process.
3. **Reversible effects**: Register timers, sockets, and subscriptions inside `ctx.effect(() => { ... return () => cleanup(); })` so `fiber.dispose()` leaks zero resources.
4. **Concurrency & idempotency**: Use `ctx.storage.runExclusive(storeKey, fn)` for read-modify-write mutations and check `isDealDelivered` / `isDealCompleted` before side effects.
5. **No secret leaks**: Never log tokens, cookies, or passwords; prefer `PKH_*` environment variables in production.
6. **No anti-bot bypasses**: `GraphQLPlayerokTransport` strictly uses standard HTTP/WS requests and raises `BotCheckDetectedError` cleanly if gated by a challenge.

## Verification Commands

```bash
pnpm lint
pnpm build
pnpm typecheck
pnpm test
```
