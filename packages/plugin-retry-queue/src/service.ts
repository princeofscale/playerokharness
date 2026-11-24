import crypto from 'node:crypto';
import {
  Context,
  escapeHtml,
  ItemDealStatuses,
  safeInterval,
  Service,
  z,
} from '@pkh/core';
import '@pkh/adapter';

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
  status: z.enum(['pending', 'dead']).default('pending'),
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
}

export interface RetryQueueStats {
  pending: number;
  dead: number;
  total: number;
}

const STORE_KEY = 'retry_queue';

export function computeBackoffMs(attempts: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(baseDelayMs * Math.pow(2, exponent), maxDelayMs);
}

export class RetryQueueService extends Service {
  static provide = 'retryQueue';
  static inject = ['storage', 'playerok'];

  private readonly log;
  private readonly handlers = new Map<string, RetryTaskHandler>();
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly defaultMaxAttempts: number;

  constructor(ctx: Context, config: RetryQueueConfig = {}) {
    super(ctx, 'retryQueue');
    this.log = ctx.logger('retryQueue');
    this.baseDelayMs = config.baseDelayMs ?? 10_000;
    this.maxDelayMs = config.maxDelayMs ?? 15 * 60 * 1000;
    this.defaultMaxAttempts = config.defaultMaxAttempts ?? 5;

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
      const status = String(payload.status ?? '') as ItemDealStatuses;
      if (!dealId || !status) {
        throw new Error('update_deal: отсутствует dealId или status');
      }
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

  public list(status?: 'pending' | 'dead'): RetryTask[] {
    const tasks = this.ctx.storage.get<RetryQueueStore>(STORE_KEY).tasks;
    return status ? tasks.filter((t) => t.status === status) : [...tasks];
  }

  public getStats(): RetryQueueStats {
    const tasks = this.list();
    let pending = 0;
    let dead = 0;
    for (const t of tasks) {
      if (t.status === 'dead') dead += 1;
      else pending += 1;
    }
    return { pending, dead, total: tasks.length };
  }

  public async enqueue(options: EnqueueTaskOptions, now: Date = new Date()): Promise<RetryTask> {
    const task = await this.ctx.storage.runExclusive(STORE_KEY, () => {
      const store = this.ctx.storage.get<RetryQueueStore>(STORE_KEY);

      if (options.dedupeKey) {
        const existing = store.tasks.find(
          (t) => t.dedupeKey === options.dedupeKey && t.status === 'pending',
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
    await this.ctx.parallel('retry/enqueued', task);
    return task;
  }

  public async processDue(now: Date = new Date()): Promise<{ succeeded: number; rescheduled: number; deadLettered: number }> {
    const dueIds = this.list('pending')
      .filter((t) => {
        const runMs = Date.parse(t.nextRunAt);
        return Number.isNaN(runMs) || runMs <= now.getTime();
      })
      .map((t) => t.id);

    let succeeded = 0;
    let rescheduled = 0;
    let deadLettered = 0;

    for (const id of dueIds) {
      const task = this.list('pending').find((t) => t.id === id);
      if (!task) continue;

      const handler = this.handlers.get(task.kind);
      if (!handler) {
        await this.markFailed(id, `Нет зарегистрированного обработчика для типа «${task.kind}»`, now, true);
        deadLettered += 1;
        continue;
      }

      try {
        await handler(task.payload, task);
        await this.removeTask(id);
        succeeded += 1;
        this.log.info(`Повторная задача [${task.kind}] #${id} успешно выполнена`);
        await this.ctx.parallel('retry/succeeded', task);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const becameDead = await this.markFailed(id, message, now, false);
        if (becameDead) deadLettered += 1;
        else rescheduled += 1;
      }
    }

    return { succeeded, rescheduled, deadLettered };
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

      if (forceDead || target.attempts >= target.maxAttempts) {
        target.status = 'dead';
      } else {
        const backoff = computeBackoffMs(target.attempts, this.baseDelayMs, this.maxDelayMs);
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
      await this.ctx.parallel('retry/dead-letter', task);
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
      if (!target) return false;
      target.status = 'pending';
      target.attempts = 0;
      target.nextRunAt = now.toISOString();
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
  }
}
