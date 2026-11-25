# pkh — architecture review, hardening log and roadmap

Written after the 2026-11-25 four-way code review (core / adapter / automation+retry /
telegram+app). Every fix listed here is covered either by an existing test or by
`test/regressions.test.ts`.

## 1. What the review found and what was fixed

### Crashes and data-loss (P0)

| Area | Defect | Fix |
|---|---|---|
| `core/schemas/settings.ts` | Zod 4 `.default({})` short-circuits and returns the literal *unparsed* value, so a config without a `playerok` key produced `playerok: {}` — a type-invalid object that throws on the next `cfg.playerok.api` dereference | `.prefault({})` |
| `plugin-automation` (bump / restore / withdrawal) | `setInterval(() => { void this.tick(); })` with no `.catch`: any API failure was an unhandled rejection, which terminates Node ≥ 15 | `safeInterval()`, which catches |
| `playerok/service.ts` | same pattern on the 30-min account refresh and 15-min ban check | `safeInterval()` |
| `core/services/lock.ts` | exists-then-create lock: two processes could both "acquire" the instance lock → two bots on one account → double delivery | atomic `O_EXCL` create + stale-pid recovery |
| `core/services/plugin-manager.ts` | `removePlugin` joined an attacker-controlled id onto `pluginsDir`, so `fs.rmSync` could delete outside it | `insidePluginsDir()` guard |
| `core/services/storage.ts` | `resolvePath()` did not confine its result to `baseDir` (reachable from the restricted storage proxy) | path containment check |
| `retry-queue` | overlapping passes (5 s timer + manual run from Telegram) executed the same task twice — a re-sent goods key | in-flight set + `safeInterval` single-flight |

### Correctness (P1)

- **Event dispatch was read from cordis internals** (`ctx.events._hooks`) with an unbound
  `hook.callback`. Still contains a cast, but the serial/parallel split now matches the
  documented `@mode` contract in `core/events.ts`.
- **Reconnect dropped the catch-up window**: `wsLostAt` was cleared *before* awaiting the
  catch-up, and failures were swallowed → 10 minutes of missed messages lost for good.
- **Own messages replayed as incoming** after reconnect → now skipped unless they are a
  `{{…}}` token.
- **`reconfigureTransport()`** (Setup Mode from Telegram) tore down the WS and never
  rebuilt it: the bot went deaf until a restart.
- **Subscriptions leaked on a dying socket** (`subscribedChatIds` marked before `send`).
- **`auto-restore` never re-fetched list items**: `'mayBePublished' in item` was always
  true because `mapItem()` defines every field, so every SOLD/EXPIRED restore threw.
- **`auto-delivery` consumed stock by list index** after an `await`: a concurrent rule
  edit deleted another rule's key.
- **Non-idempotent chat send was retried 3×**: a timeout after server-side success
  re-sent the goods key. Now 1 attempt by default; the retry queue owns retries.

### Security (P1)

- `ctx.get('storage')` returned the **real** StorageService, bypassing the proxy.
- `ctx.storage.set('idempotency', …)`, `markDealDelivered()`, `markDealCompleted()`,
  `rebindItem()` were reachable from an untrusted plugin — wiping the double-delivery
  guard, the money-safety net.
- `registerStore()` allowed re-registering `config` with a permissive schema.
- **Config export leaked secrets**: `cfg:export` shipped `exportSnapshot()` (Telegram
  token, PlayerOK cookies, bot password) into the chat history.
- Class-based untrusted plugins were invoked without `new` → dead on arrival.

### Reliability and DX (P2)

- `safeInterval` now skips a tick while the previous run is still in flight (default).
- `vitest` still aliases `@pkh/*` to `dist/`, so `pnpm test` must be preceded by a build —
  CI does this; `pnpm test` locally does not (see §4).
- Untrusted-plugin isolation is **best-effort**, not a sandbox: `ctx.fiber.parent` still
  reaches the root context, and an imported `.mjs` can `import fs`. Real isolation needs a
  child process/worker with a message-passing API (see §4).
- Unknown retry-queue `kind` was force-dead-lettered on the first poll; now it burns a
  normal attempt so a plugin registering its handler later still gets its tasks.
- `orders-cache`, `cached_orders` and the idempotency store now have bounded retention
  (180 d / 30 d + 5000-entry cap, evicted by timestamp, not insertion order).

## 2. Do we need a second language?

**No.** The workload is I/O bound at single-seller scale: a handful of HTTP calls and a
long-lived WebSocket per account, a few hundred events per day, JSON state of a few
megabytes. Node already spends nearly all of its time waiting.

Adding Rust/Go/Python would cost a second toolchain in CI, a second release matrix, and an
IPC boundary — for no measurable gain:

- **CPU** is not the bottleneck; the only heavy loop is JSON (de)serialisation, which is
  native V8 code.
- **Anti-bot / TLS fingerprinting** is explicitly out of scope (the project refuses to
  bypass PlayerOK protections), and that is the one place where a native client would
  actually matter.
- **Memory safety** is a TypeScript concern that a sidecar does not solve: the risky code is
  business logic, not memory.

Where a second language *would* pay off, if it ever becomes necessary:

1. A **WASM module** for a hot, pure computation (e.g. bulk price analytics over years of
   `cached_orders`) — no toolchain in CI if the `.wasm` is committed and only rebuilt on
   demand.
2. A **Rust/Go sidecar** only if the platform ever offers an officially supported API with
   high request volume and strict rate limiting, where a bounded-concurrency scheduler
   matters.
3. **Nothing else.** Python would duplicate the current runtime's job with worse typing.

## 3. Roadmap — what to build next

Ordered by value per unit of work.

1. **SQLite persistence (`better-sqlite3` + migrations).** Today every event re-reads and
   Zod-parses whole JSON files, and every write rewrites one. A single SQLite file gives
   transactions, atomic compare-and-set for the idempotency guards, pruning by index, and
   removes `runExclusive` from the hot path. This is the highest-value change left.
2. **PlayerOK response contract guard.** 47 `any` casts live in `graphql-transport.ts`;
   a renamed field silently becomes `undefined` and can default a deal status to PAID.
   Add Zod schemas per response + a "contract drift" boot-report entry, plus recorded
   fixtures replayed in CI.
3. **`@pkh/plugin-web`.** Read-only dashboard first (status, deals, retry queue/DLQ, log
   tail) on Fastify + SSE. Faster than Telegram for browsing history; keeps the bot UI for
   actions.
4. **Stock model instead of string arrays.** `auto_deliveries.goods[]` has no state: a
   crash between reserve and send is only recoverable by hand. A `stock` table with
   `available | reserved | sold` + a `deal_id` reference makes double-sell structurally
   impossible.
5. **Observability.** `pino` JSON logs, `prom-client` `/metrics`, an optional Sentry DSN,
   and a `/health` endpoint for systemd/uptime checks.
6. **grammY `runner`.** grammY processes updates strictly sequentially, so one slow handler
   (a 48-chat fetch, a `rq:run`) blocks every other admin. `@grammyjs/runner` +
   `sequentialize` fixes the head-of-line blocking.
7. **Plugin manifest + signature.** External `.mjs` is arbitrary code executed in-process.
   At minimum: a manifest with a content hash, a "trusted" prompt, and a warning that
   isolation is cooperative only.

## 4. Accepted risks (documented, not fixed)

- Untrusted plugin isolation is cooperative (`ctx.fiber.parent`, `import fs`).
- `pnpm test` uses prebuilt `dist/`; run `pnpm build` first (CI does).
- Retry-queue leases are in-process only; a second `pkh start` on the same data dir is
  prevented by `LockService`, not by the queue itself.
- Telegram `callback_data` is capped at 64 bytes; keys longer than a few characters are
  truncated in the UI (rare, cosmetic).

## 5. Round 2 (2026-11-25, same day) — shipped

- **@pkh/plugin-web** — dependency-free read-only dashboard (node:http + SSE):
  /, /deals, /queue, /logs, /api/*, /events, /healthz. Token-gated with
  timingSafeEqual + httpOnly cookie; refuses to bind a non-loopback host without a token.
  Wired into createApplication (enableWeb / --web / PKH_WEB_*) with a ready promise, so
  startup ordering is deterministic and a bind failure becomes a log line.
- **Contract guard** — packages/playerok/src/schemas.ts: 13 loose Zod schemas for the
  GraphQL/WS payloads we consume, applied at 14 call sites. Drift is recorded as
  ContractIssue (ring buffer 50) instead of throwing, mapping stays best-effort, and
  bootstrap logs newly observed drift every 10 minutes.
- **Retry-queue leases** — pending | processing | dead with claimedAt/claimedBy,
  expired-lease reclaim (5 min, emitted as retry/lease-reclaimed), DLQ retention
  (14 days / 500 tasks, pruned in the poll pass) and ±20 % backoff jitter.
- **Automation fixes** — restore-by-id for SOLD items, stock rollback when the retry
  queue rejects a task, first-message !продавец escalation, honest withdrawal errors,
  attribute-safe notification escaping.
- **Config safety** — getConfig() no longer mutates the parsed object, and set() strips
  any value still equal to a PKH_* override, so a settings round-trip cannot persist an
  environment secret.
- **Tooling** — pretest builds the workspace; CI now does a cold (pnpm clean) build.

Still open from section 3: SQLite persistence, a stock model with reserved/sold states,
@grammyjs/runner, plugin manifest/signature, and mutation-response contract schemas.

## 6. Round 3 (2026-11-25) — shipped

- **@pkh/plugin-analytics** — persistent sales analytics (bot_data/analytics.json):
  per-day revenue/orders/completed/cancelled buckets, top items, idempotent backfill from
  cached_orders, calendar day/week/month windows, 400-day + 5000-marker retention.
  Mounted on the root context so the panel can read it.
- **Mutation contract guard** — 9 loose Zod envelopes covering every GraphQL mutation we
  call; drift is recorded instead of becoming an undefined field, and the image upload
  (uploadChatImageIntoTemporaryStore) now fails with a clear error instead of a null deref.
- **Dashboard analytics + resilient SSE** — /analytics and /api/analytics computed from the
  order cache, SSE frames carry ids, a 200-event ring buffer replays on Last-Event-ID, and
  a 15 s heartbeat keeps proxies from closing idle streams.
- **Core hardening** — logs rotate into latest.log.1/.2 instead of being truncated, recent
  lines are tail-read, expired access requests are pruned from disk, and a corrupt store
  recovery is reported once to the log and the boot report instead of silently resetting.
- **Panel** — the Statistics screen shows the top-5 items by revenue for the selected period.
- **Ops** — pkh doctor reports retry-queue/DLQ depth, a stale boot marker and dashboard
  state; CI runs a cold build, a CLI smoke test (help/doctor/dry-run simulation) and now
  typechecks the test suite through tsconfig.test.json.

Still open: SQLite persistence, a stock model with reserved/sold states, @grammyjs/runner,
plugin manifest/signature, and net-profit tracking (revenue is gross today).
