import crypto from 'node:crypto';
import os from 'node:os';
import {
  Context,
  escapeHtml,
  ItemDealStatuses,
  safeInterval,
  Service,
  z,
} from '@pkh/core';
import '@pkh/adapter';

/**
 * Lifecycle of a queued task:
 * - `pending`     — waiting for `nextRunAt`, nobody is working on it;
 * - `processing`  — leased by a poll pass (`claimedAt`/`claimedBy`), hidden from other passes;
 * - `dead`        — exhausted its attempts and lives in the Dead-Letter Queue.
 */
export const RetryTaskStatusSchema = z.enum(['pending', 'processing', 'dead']);

export type RetryTaskStatus = z.infer<typeof RetryTaskStatusSchema>;

export const RetryTaskSchema = z.object({
  id: z.string(),
  kind: z.string(),
  dedupeKey: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(5),
  nextRunAt: z.string(),
  createdAt: z.string(),
  lastError: z.string().optional(),
  status: RetryTaskStatusSchema.default('pending'),
  /** Lease timestamp (ISO): set when a pass claims the task, cleared when the attempt ends. */
  claimedAt: z.string().optional(),
  /** Lease owner identity `<pid>@<hostname>`: lets operators see who held an expired lease. */
  claimedBy: z.string().optional(),
  /** When the task entered the DLQ; anchors retention so a long-lived task is not pruned on birth. */
  deadAt: z.string().optional(),
});

export type RetryTask = z.infer<typeof RetryTaskSchema>;

export const RetryQueueStoreSchema = z.object({
  tasks: z.array(RetryTaskSchema).default([]),
});

export type RetryQueueStore = z.infer<typeof RetryQueueStoreSchema>;

export type RetryTaskHandler = (payload: Record<string, unknown>, task: RetryTask) => Promise<void> | void;

export interface EnqueueTaskOptions {
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  maxAttempts?: number;
  initialDelayMs?: number;
  error?: string;
}

export interface RetryQueueConfig {
  pollIntervalMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  defaultMaxAttempts?: number;
  enableTimer?: boolean;
  /** A task stuck in 'processing' for longer than this is reclaimed by the next poll pass. */
  leaseMs?: number;
  /** Dead tasks whose DLQ entry is older than this many days are pruned (default 14). */
  deadRetentionDays?: number;
  /** Upper bound on stored tasks; dead tasks are pruned oldest-first to enforce it (default 500). */
  maxTasks?: number;
}

export interface RetryQueueStats {
  /** Every task that is not dead, leased ('processing') ones included. */
  pending: number;
  dead: number;
  total: number;
  /** Leased tasks — a subset of `pending`. Filled by `getStats(true)` only. */
  processing?: number;
  /** Expired leases reclaimed since this service started. Filled by `getStats(true)` only. */
  expiredLeases?: number;
  /** Tasks removed by the retention policy since this service started. Filled by `getStats(true)` only. */
  pruned?: number;
}

export interface ProcessDueResult {
  succeeded: number;
  rescheduled: number;
  deadLettered: number;
}

/** Outcome of one atomic claim attempt inside a poll pass. */
interface ClaimOutcome {
  task: RetryTask | null;
  reclaimedLease: boolean;
  /** Owner of the lease that had expired, for the audit log and the reclaim event. */
  previousClaimedBy?: string;
}

const STORE_KEY = 'retry_queue';

/** `<pid>@<hostname>` of the process that owns a lease; written into every claim. */
export function currentWorkerId(): string {
  return `${process.pid}@${os.hostname()}`;
}

export function computeBackoffMs(attempts: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(baseDelayMs * Math.pow(2, exponent), maxDelayMs);
}

/** Jitter spread used by {@link nextDelay}: plus or minus 20% around the pure backoff. */
export const BACKOFF_JITTER_RATIO = 0.2;

/**
 * Backoff for the next attempt with +/-20% jitter.
 *
 * `computeBackoffMs` stays deterministic (tests and operators rely on it); the jitter lives
 * here so a thundering herd of tasks that failed at the same instant does not retry in lockstep.
 * `random` is injectable, which keeps this function testable without mocking Math.random.
 */
export function nextDelay(
  attempts: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const deterministic = computeBackoffMs(attempts, baseDelayMs, maxDelayMs);
  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  const factor = 1 + BACKOFF_JITTER_RATIO * (normalized * 2 - 1);
  // The jittered value may exceed maxDelayMs by up to BACKOFF_JITTER_RATIO on purpose: the cap
  // stays authoritative for the deterministic series, the spread only decorrelates retries.
  return Math.round(deterministic * factor);
}

/**
 * A payload error that can never succeed. The poll pass sends such a task straight to the
 * Dead-Letter Queue instead of burning its remaining attempts on a deterministic failure.
 */
export class PermanentTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentTaskError';
  }
}

const ITEM_DEAL_STATUS_VALUES: readonly string[] = Object.values(ItemDealStatuses);

/** Type guard over `ItemDealStatuses`, used instead of casting arbitrary payload strings. */
export function isItemDealStatus(value: string): value is ItemDealStatuses {
  return ITEM_DEAL_STATUS_VALUES.includes(value);
}

export class RetryQueueService extends Service {
  static provide = 'retryQueue';
  static inject = ['storage', 'playerok'];

  private readonly log;
  private readonly handlers = new Map<string, RetryTaskHandler>();
  /** Задачи, выполняющиеся прямо сейчас в этом процессе: защита от двойного запуска. */
  private readonly inFlight = new Set<string>();
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly defaultMaxAttempts: number;
  private readonly leaseMs: number;
  private readonly deadRetentionDays: number;
  private readonly maxTasks: number;
  /** Lease owner written into every claim: `<pid>@<hostname>`. */
  private readonly workerId = currentWorkerId();
  /** Expired leases reclaimed since start — observability counter, see getStats(true). */
  private expiredLeases = 0;
  /** Tasks dropped by the retention policy since start; see getStats(true). */
  private prunedTasks = 0;

  constructor(ctx: Context, config: RetryQueueConfig = {}) {
    super(ctx, 'retryQueue');
    this.log = ctx.logger('retryQueue');
    this.baseDelayMs = config.baseDelayMs ?? 10_000;
    this.maxDelayMs = config.maxDelayMs ?? 15 * 60 * 1000;
    this.defaultMaxAttempts = config.defaultMaxAttempts ?? 5;
    this.leaseMs = config.leaseMs ?? 5 * 60 * 1000;
    this.deadRetentionDays = config.deadRetentionDays ?? 14;
    this.maxTasks = config.maxTasks ?? 500;

    ctx.storage.registerStore<RetryQueueStore>({
      name: STORE_KEY,
      relativePath: 'bot_data/retry_queue.json',
      schema: RetryQueueStoreSchema,
      defaultValue: () => ({ tasks: [] }),
      restoreMissing: true,
      exportable: false,
    });

    this.registerBuiltInHandlers();

    if (config.enableTimer !== false) {
      const pollMs = config.pollIntervalMs ?? 5_000;
      safeInterval(
        ctx,
        async () => {
          await this.processDue();
        },
        pollMs,
        'retryQueue:poll',
      );
    }
  }

  private registerBuiltInHandlers(): void {
    this.registerHandler('send_message', async (payload) => {
      const chatId = String(payload.chatId ?? '');
      const text = typeof payload.text === 'string' ? payload.text : null;
      if (!chatId || !text) {
        throw new Error('send_message: отсутствует chatId или text');
      }
      const sent = await this.ctx.playerok.sendMessage(chatId, text, {
        excludeWatermark: Boolean(payload.excludeWatermark),
        markChatAsRead:
          typeof payload.markChatAsRead === 'boolean' ? payload.markChatAsRead : undefined,
        maxAttempts: 1,
      });
      if (!sent) {
        throw new Error(`sendMessage вернул null для чата ${chatId}`);
      }
    });

    this.registerHandler('update_deal', async (payload) => {
      const dealId = String(payload.dealId ?? '');
      const rawStatus = String(payload.status ?? '');
      if (!dealId || !rawStatus) {
        throw new Error('update_deal: отсутствует dealId или status');
      }
      // A status outside ItemDealStatuses can never become valid on a retry: dead-letter it
      // immediately with the offending value instead of casting garbage into the API call.
      if (!isItemDealStatus(rawStatus)) {
        throw new PermanentTaskError(
          `update_deal: недопустимый статус сделки «${rawStatus}» (допустимо: ${ITEM_DEAL_STATUS_VALUES.join(', ')})`,
        );
      }
      const status = rawStatus;
      await this.ctx.playerok.updateDeal(dealId, status);
      if (status === ItemDealStatuses.SENT) {
        this.ctx.storage.markDealCompleted(dealId);
      }
    });

    this.registerHandler('publish_item', async (payload) => {
      const itemId = String(payload.itemId ?? '');
      const priorityStatusId = String(payload.priorityStatusId ?? '');
      if (!itemId || !priorityStatusId) {
        throw new Error('publish_item: отсутствует itemId или priorityStatusId');
      }
      await this.ctx.playerok.publishItem(itemId, priorityStatusId);
    });

    this.registerHandler('bump_item', async (payload) => {
      const itemId = String(payload.itemId ?? '');
      const priorityStatusId = String(payload.priorityStatusId ?? '');
      if (!itemId || !priorityStatusId) {
        throw new Error('bump_item: отсутствует itemId или priorityStatusId');
      }
      await this.ctx.playerok.increaseItemPriorityStatus(itemId, priorityStatusId);
    });
  }

  public registerHandler(kind: string, handler: RetryTaskHandler): () => void {
    this.handlers.set(kind, handler);
    return () => {
      if (this.handlers.get(kind) === handler) {
        this.handlers.delete(kind);
      }
    };
  }

  public list(status?: RetryTaskStatus): RetryTask[] {
    const tasks = this.ctx.storage.get<RetryQueueStore>(STORE_KEY).tasks;
    return status ? tasks.filter((t) => t.status === status) : [...tasks];
  }

  /**
   * Queue composition. The default call keeps the legacy three-field shape (`pending` counts
   * every task that is not dead, leased ones included); `getStats(true)` additionally breaks
   * out the leased subset and reports the retention counters for monitoring.
   */
  public getStats(detailed = false): RetryQueueStats {
    const tasks = this.list();
    let dead = 0;
    let processing = 0;
    for (const t of tasks) {
      if (t.status === 'dead') dead += 1;
      else if (t.status === 'processing') processing += 1;
    }

    const stats: RetryQueueStats = {
      pending: tasks.length - dead,
      dead,
      total: tasks.length,
    };

    if (detailed) {
      stats.processing = processing;
      stats.expiredLeases = this.expiredLeases;
      stats.pruned = this.prunedTasks;
    }

    return stats;
  }

  public async enqueue(options: EnqueueTaskOptions, now: Date = new Date()): Promise<RetryTask> {
    const task = await this.ctx.storage.runExclusive(STORE_KEY, () => {
      const store = this.ctx.storage.get<RetryQueueStore>(STORE_KEY);

      if (options.dedupeKey) {
        // 'processing' is live too: while the first copy is being retried, a second copy
        // would run the same side effect again as soon as the first attempt ends
        // (a duplicate bump charges the premium twice, a duplicate send re-delivers goods).
        const existing = store.tasks.find(
          (t) => t.dedupeKey === options.dedupeKey && t.status !== 'dead',
        );
        if (existing) {
          if (options.error) {
            existing.lastError = options.error;
            this.ctx.storage.set<RetryQueueStore>(STORE_KEY, store);
          }
          return existing;
        }
      }

      const delay = options.initialDelayMs ?? this.baseDelayMs;
      const created: RetryTask = {
        id: crypto.randomUUID().slice(0, 12),
        kind: options.kind,
        dedupeKey: options.dedupeKey,
        payload: structuredClone(options.payload),
        attempts: 0,
        maxAttempts: options.maxAttempts ?? this.defaultMaxAttempts,
        nextRunAt: new Date(now.getTime() + delay).toISOString(),
        createdAt: now.toISOString(),
        lastError: options.error,
        status: 'pending',
      };
      store.tasks.push(created);
      this.ctx.storage.set<RetryQueueStore>(STORE_KEY, store);
      return created;
    });

    this.log.warn(
      `Задача поставлена в очередь повторов: [${task.kind}] #${task.id}${task.lastError ? ` (${task.lastError})` : ''}`,
    );
    // The task is already persisted: a throwing listener must not make the caller believe
    // the hand-off failed (auto-delivery would return the reserved key to stock while the
    // very same key still sits in a queued retry — the same goods sold twice).
    await this.emitSafely('retry/enqueued', task);
    return task;
  }

  /**
   * Runs every due task: 'pending' tasks whose nextRunAt has passed, plus 'processing'
   * tasks whose lease expired (their owner died mid-run, e.g. a crash or a restart).
   *
   * Each task is claimed atomically (pending -> processing, stamped with claimedAt/claimedBy)
   * BEFORE its handler is invoked, so overlapping passes - including a second process sharing
   * the same data directory - cannot execute the same task twice. The in-flight Set remains as
   * a cheap in-process fast path that skips the storage round-trip for overlapping passes.
   */
  public async processDue(now: Date = new Date()): Promise<ProcessDueResult> {
    const dueIds = this.list()
      .filter((task) => this.isDue(task, now))
      .map((task) => task.id);

    let succeeded = 0;
    let rescheduled = 0;
    let deadLettered = 0;

    for (const id of dueIds) {
      // Проходы могут перекрываться (5-секундный таймер + ручной запуск из Telegram),
      // и без этой проверки одна и та же задача выполнялась дважды: повторный
      // bump_item/publish_item списывал премиум заново, а send_message дублировал текст.
      if (this.inFlight.has(id)) continue;

      this.inFlight.add(id);
      try {
        const claim = await this.claimTask(id, now);
        if (!claim.task) continue;
        const task = claim.task;

        if (claim.reclaimedLease) {
          this.expiredLeases += 1;
          this.log.warn(
            `Задача [${task.kind}] #${task.id}: просроченная аренда (${claim.previousClaimedBy ?? 'владелец неизвестен'}) возвращена в обработку`,
          );
          await this.emitSafely('retry/lease-reclaimed', task);
        }

        const handler = this.handlers.get(task.kind);
        if (!handler) {
          // A plugin registered later (or a not-yet-loaded one) may own this kind:
          // treat it as a normal failed attempt so the task survives until maxAttempts.
          const becameDead = await this.markFailed(
            id,
            `Нет зарегистрированного обработчика для типа «${task.kind}»`,
            now,
            false,
          );
          if (becameDead) deadLettered += 1;
          else rescheduled += 1;
          continue;
        }

        // Only the handler itself may turn this attempt into a failure. Lease removal,
        // counters and lifecycle events used to share this try, so a throwing
        // `retry/succeeded` listener re-marked a successful task as failed and reported it
        // twice (succeeded + rescheduled).
        let failed = false;
        let handlerError: unknown;
        try {
          await handler(task.payload, task);
        } catch (err) {
          failed = true;
          handlerError = err;
        }

        if (!failed) {
          try {
            await this.removeTask(id);
          } catch (err) {
            // The side effect already happened: a bookkeeping failure must never hand the
            // task back for another attempt (a second bump/publish/send charges twice).
            this.log.error(
              `Задача [${task.kind}] #${id} выполнена, но не удалена из очереди: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          succeeded += 1;
          this.log.info(`Повторная задача [${task.kind}] #${id} успешно выполнена`);
          await this.emitSafely('retry/succeeded', task);
          continue;
        }

        // A PermanentTaskError means the payload itself is invalid: retrying cannot help,
        // so the task goes to the DLQ at once and the DLQ message carries the reason.
        const message = handlerError instanceof Error ? handlerError.message : String(handlerError);
        const becameDead = await this.markFailed(
          id,
          message,
          now,
          handlerError instanceof PermanentTaskError,
        );
        if (becameDead) deadLettered += 1;
        else rescheduled += 1;
      } finally {
        this.inFlight.delete(id);
      }
    }

    // Retention runs once per poll pass (never on enqueue): the enqueue path stays cheap and
    // the clock is the pass's own now, which keeps tests deterministic.
    const pruned = await this.prune(now);
    if (pruned > 0) {
      this.prunedTasks += pruned;
      this.log.info(`Очередь повторов: удалено задач по политике хранения — ${pruned}`);
    }

    return { succeeded, rescheduled, deadLettered };
  }

  /**
   * Dispatches a task-lifecycle event without letting a misbehaving listener undo the state
   * change that already happened: `ctx.parallel` rejects as soon as one listener throws, and
   * an aborting emit used to cancel the whole poll pass (the remaining due tasks were skipped
   * until the next tick) or make `enqueue` reject after the task had been persisted.
   */
  private async emitSafely(
    event: 'retry/enqueued' | 'retry/succeeded' | 'retry/dead-letter' | 'retry/lease-reclaimed',
    task: RetryTask,
  ): Promise<void> {
    try {
      await this.ctx.parallel(event, task);
    } catch (err) {
      this.log.error(
        `Обработчик события «${event}» завершился ошибкой: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private isDue(task: RetryTask, now: Date): boolean {
    if (task.status === 'processing') return this.isLeaseExpired(task, now);
    if (task.status !== 'pending') return false;
    const runMs = Date.parse(task.nextRunAt);
    return Number.isNaN(runMs) || runMs <= now.getTime();
  }

  /**
   * A lease is expired once it is older than leaseMs. A record without a parseable claimedAt
   * counts as expired on purpose: a half-written claim must not park a task forever.
   */
  private isLeaseExpired(task: RetryTask, now: Date): boolean {
    const claimedMs = task.claimedAt ? Date.parse(task.claimedAt) : Number.NaN;
    if (Number.isNaN(claimedMs)) return true;
    return now.getTime() - claimedMs >= this.leaseMs;
  }

  /**
   * Atomically moves one task into the 'processing' state.
   *
   * The read-modify-write body is fully synchronous, so a competing claim re-reads the file
   * after the winner's write and sees status 'processing' with a fresh lease: the loser gets
   * task null and never touches the handler.
   */
  private async claimTask(taskId: string, now: Date): Promise<ClaimOutcome> {
    let outcome: ClaimOutcome = { task: null, reclaimedLease: false };

    await this.ctx.storage.runExclusive(STORE_KEY, () => {
      const store = this.ctx.storage.get<RetryQueueStore>(STORE_KEY);
      const target = store.tasks.find((t) => t.id === taskId);
      if (!target) return;

      let reclaimedLease = false;
      if (target.status === 'processing') {
        if (!this.isLeaseExpired(target, now)) return;
        reclaimedLease = true;
      } else if (target.status !== 'pending') {
        return;
      }

      const previousClaimedBy = target.claimedBy;
      target.status = 'processing';
      target.claimedAt = now.toISOString();
      target.claimedBy = this.workerId;
      this.ctx.storage.set<RetryQueueStore>(STORE_KEY, store);

      outcome = { task: structuredClone(target), reclaimedLease, previousClaimedBy };
    });

    return outcome;
  }

  /**
   * Retention policy, executed by every poll pass:
   * 1) dead tasks whose DLQ entry is older than deadRetentionDays are removed;
   * 2) while the store holds more than maxTasks entries, the oldest dead tasks are removed.
   *
   * Pending and processing work is never pruned: silently dropping it would lose a side
   * effect this queue exists to guarantee.
   */
  private async prune(now: Date): Promise<number> {
    let removed = 0;

    await this.ctx.storage.runExclusive(STORE_KEY, () => {
      const store = this.ctx.storage.get<RetryQueueStore>(STORE_KEY);
      const cutoffMs = now.getTime() - this.deadRetentionDays * 24 * 60 * 60 * 1000;

      const kept: RetryTask[] = [];
      for (const task of store.tasks) {
        if (task.status === 'dead' && this.deadTaskTimestamp(task) < cutoffMs) {
          removed += 1;
          continue;
        }
        kept.push(task);
      }

      if (kept.length > this.maxTasks) {
        const deadEntries = kept
          .map((task, index) => ({
            index,
            timestamp: this.deadTaskTimestamp(task),
            isDead: task.status === 'dead',
          }))
          .filter((entry) => entry.isDead)
          .sort((a, b) => a.timestamp - b.timestamp);

        const dropped = new Set<number>();
        for (const entry of deadEntries) {
          if (kept.length - dropped.size <= this.maxTasks) break;
          dropped.add(entry.index);
        }

        if (dropped.size > 0) {
          const survivors = kept.filter((_, index) => !dropped.has(index));
          kept.length = 0;
          kept.push(...survivors);
          removed += dropped.size;
        }
      }

      if (removed > 0) {
        store.tasks = kept;
        this.ctx.storage.set<RetryQueueStore>(STORE_KEY, store);
      }
    });

    return removed;
  }

  /** When the task landed in the DLQ, falling back to schedule/creation for legacy records. */
  private deadTaskTimestamp(task: RetryTask): number {
    for (const iso of [task.deadAt, task.nextRunAt, task.createdAt]) {
      const ms = iso ? Date.parse(iso) : Number.NaN;
      if (!Number.isNaN(ms)) return ms;
    }
    return 0;
  }

  private async markFailed(
    taskId: string,
    errorMessage: string,
    now: Date,
    forceDead: boolean,
  ): Promise<boolean> {
    let updatedTask: RetryTask | null = null;

    await this.ctx.storage.runExclusive(STORE_KEY, () => {
      const store = this.ctx.storage.get<RetryQueueStore>(STORE_KEY);
      const target = store.tasks.find((t) => t.id === taskId);
      if (!target) return;

      target.attempts += 1;
      target.lastError = errorMessage;
      // The attempt is over, so its lease is released: the next pass must be able to claim
      // the task again (the in-flight Set is per-process and disappears with the process).
      target.status = 'pending';
      target.claimedAt = undefined;
      target.claimedBy = undefined;

      if (forceDead || target.attempts >= target.maxAttempts) {
        target.status = 'dead';
        target.deadAt = now.toISOString();
      } else {
        const backoff = nextDelay(target.attempts, this.baseDelayMs, this.maxDelayMs);
        target.nextRunAt = new Date(now.getTime() + backoff).toISOString();
      }

      updatedTask = structuredClone(target);
      this.ctx.storage.set<RetryQueueStore>(STORE_KEY, store);
    });

    if (!updatedTask) return false;
    const task: RetryTask = updatedTask;

    if (task.status === 'dead') {
      this.log.error(
        `Задача [${task.kind}] #${task.id} переведена в Dead-Letter после ${task.attempts} попыток: ${errorMessage}`,
      );
      await this.emitSafely('retry/dead-letter', task);
      try {
        await this.ctx.parallel('notify/log', {
          title: `☠️ Задача <code>${escapeHtml(task.kind)}</code> #${escapeHtml(task.id)} попала в Dead-Letter`,
          body: `Попыток: <b>${task.attempts}/${task.maxAttempts}</b>\nОшибка: <blockquote>${escapeHtml(errorMessage)}</blockquote>`,
          buttons: [
            [
              { text: '♻️ Повторить', callbackData: `rq:retry:${task.id}` },
              { text: '🗑 Удалить', callbackData: `rq:del:${task.id}` },
            ],
            [{ text: '🔁 Открыть очередь', callbackData: 'menu:retry_queue' }],
          ],
        });
      } catch (err) {
        this.log.error(
          `Не удалось отправить уведомление о Dead-Letter задаче #${task.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return true;
    }

    this.log.warn(
      `Задача [${task.kind}] #${task.id} не удалась (${task.attempts}/${task.maxAttempts}), следующая попытка в ${task.nextRunAt}: ${errorMessage}`,
    );
    return false;
  }

  public async retryDeadTask(taskId: string, now: Date = new Date()): Promise<boolean> {
    return this.ctx.storage.runExclusive(STORE_KEY, () => {
      const store = this.ctx.storage.get<RetryQueueStore>(STORE_KEY);
      const target = store.tasks.find((t) => t.id === taskId);
      // Resurrecting a task that another poll pass currently holds a lease on would run it
      // twice (the in-flight handler plus the queued copy), so only DLQ entries qualify.
      if (!target || target.status !== 'dead') return false;
      target.status = 'pending';
      target.attempts = 0;
      target.nextRunAt = now.toISOString();
      target.claimedAt = undefined;
      target.claimedBy = undefined;
      target.deadAt = undefined;
      this.ctx.storage.set<RetryQueueStore>(STORE_KEY, store);
      return true;
    });
  }

  public async retryAllDead(now: Date = new Date()): Promise<number> {
    return this.ctx.storage.runExclusive(STORE_KEY, () => {
      const store = this.ctx.storage.get<RetryQueueStore>(STORE_KEY);
      let count = 0;
      for (const task of store.tasks) {
        if (task.status === 'dead') {
          task.status = 'pending';
          task.attempts = 0;
          task.nextRunAt = now.toISOString();
          task.claimedAt = undefined;
          task.claimedBy = undefined;
          task.deadAt = undefined;
          count += 1;
        }
      }
      if (count > 0) {
        this.ctx.storage.set<RetryQueueStore>(STORE_KEY, store);
      }
      return count;
    });
  }

  public async removeTask(taskId: string): Promise<boolean> {
    return this.ctx.storage.runExclusive(STORE_KEY, () => {
      const store = this.ctx.storage.get<RetryQueueStore>(STORE_KEY);
      const prevLen = store.tasks.length;
      store.tasks = store.tasks.filter((t) => t.id !== taskId);
      if (store.tasks.length !== prevLen) {
        this.ctx.storage.set<RetryQueueStore>(STORE_KEY, store);
        return true;
      }
      return false;
    });
  }

  public async clearDead(): Promise<number> {
    return this.ctx.storage.runExclusive(STORE_KEY, () => {
      const store = this.ctx.storage.get<RetryQueueStore>(STORE_KEY);
      const prevLen = store.tasks.length;
      store.tasks = store.tasks.filter((t) => t.status !== 'dead');
      const removed = prevLen - store.tasks.length;
      if (removed > 0) {
        this.ctx.storage.set<RetryQueueStore>(STORE_KEY, store);
      }
      return removed;
    });
  }
}

declare module 'cordis' {
  interface Context {
    retryQueue: RetryQueueService;
  }

  interface Events {
    /** @mode parallel */
    'retry/enqueued'(task: RetryTask): void | Promise<void>;
    /** @mode parallel */
    'retry/succeeded'(task: RetryTask): void | Promise<void>;
    /** @mode parallel */
    'retry/dead-letter'(task: RetryTask): void | Promise<void>;
    /** @mode parallel */
    'retry/lease-reclaimed'(task: RetryTask): void | Promise<void>;
  }
}
