import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Context,
  ItemDealStatuses,
  StorageService,
  type NotificationPayload,
} from '@pkh/core';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import {
  computeBackoffMs,
  RetryQueueService,
  type RetryTask,
} from '@pkh/plugin-retry-queue';
import { createApplication } from '@pkh/app';
import { renderMainMenu, renderRetryQueue } from '@pkh/plugin-telegram';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-test-rq-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('@pkh/plugin-retry-queue', () => {
  it('computes exponential backoff capped at maxDelayMs', () => {
    expect(computeBackoffMs(1, 1000, 10_000)).toBe(1000);
    expect(computeBackoffMs(2, 1000, 10_000)).toBe(2000);
    expect(computeBackoffMs(3, 1000, 10_000)).toBe(4000);
    expect(computeBackoffMs(4, 1000, 10_000)).toBe(8000);
    expect(computeBackoffMs(5, 1000, 10_000)).toBe(10_000);
  });

  it('deduplicates pending tasks by dedupeKey and succeeds after transient failure', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(PlayerokService, { dryRun: true, enableMaintenanceLoops: false });
    await ctx.use(RetryQueueService, {
      enableTimer: false,
      baseDelayMs: 1000,
      maxDelayMs: 8000,
      defaultMaxAttempts: 3,
    });

    const events: string[] = [];
    ctx.on('retry/enqueued', (task) => {
      events.push(`enqueued:${task.id}`);
    });
    ctx.on('retry/succeeded', (task) => {
      events.push(`succeeded:${task.id}`);
    });

    let failCount = 1;
    let executedPayload: Record<string, unknown> | null = null;
    ctx.retryQueue.registerHandler('custom_op', async (payload) => {
      if (failCount > 0) {
        failCount -= 1;
        throw new Error('HTTP 503 Service Unavailable');
      }
      executedPayload = payload;
    });

    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const first = await ctx.retryQueue.enqueue(
      {
        kind: 'custom_op',
        payload: { orderId: 'o-1' },
        dedupeKey: 'op:o-1',
        initialDelayMs: 1000,
        error: 'initial timeout',
      },
      t0,
    );
    const dup = await ctx.retryQueue.enqueue(
      {
        kind: 'custom_op',
        payload: { orderId: 'o-1' },
        dedupeKey: 'op:o-1',
        error: 'second timeout',
      },
      t0,
    );

    expect(dup.id).toBe(first.id);
    expect(ctx.retryQueue.list()).toHaveLength(1);
    expect(ctx.retryQueue.list()[0].lastError).toBe('second timeout');

    // Too early -> not due yet
    const early = await ctx.retryQueue.processDue(new Date(t0.getTime() + 500));
    expect(early).toEqual({ succeeded: 0, rescheduled: 0, deadLettered: 0 });

    // First due run fails -> rescheduled with 1000ms backoff
    const t1 = new Date(t0.getTime() + 1000);
    const firstRun = await ctx.retryQueue.processDue(t1);
    expect(firstRun).toEqual({ succeeded: 0, rescheduled: 1, deadLettered: 0 });
    expect(ctx.retryQueue.list('pending')[0].attempts).toBe(1);
    expect(ctx.retryQueue.list('pending')[0].lastError).toBe('HTTP 503 Service Unavailable');

    // Second due run succeeds -> task removed
    const t2 = new Date(t1.getTime() + 1500);
    const secondRun = await ctx.retryQueue.processDue(t2);
    expect(secondRun).toEqual({ succeeded: 1, rescheduled: 0, deadLettered: 0 });
    expect(ctx.retryQueue.list()).toHaveLength(0);
    expect(executedPayload).toEqual({ orderId: 'o-1' });
    expect(events).toContain(`succeeded:${first.id}`);

    await ctx.fiber.dispose();
  });

  it('moves exhausted tasks to Dead-Letter Queue, notifies Telegram, and supports manual recovery', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(PlayerokService, { dryRun: true, enableMaintenanceLoops: false });
    await ctx.use(RetryQueueService, {
      enableTimer: false,
      baseDelayMs: 100,
      maxDelayMs: 400,
      defaultMaxAttempts: 2,
    });

    const deadEvents: RetryTask[] = [];
    const notifications: NotificationPayload[] = [];
    ctx.on('retry/dead-letter', (task) => {
      deadEvents.push(task);
    });
    ctx.on('notify/log', (payload) => {
      notifications.push(payload);
    });

    let shouldFail = true;
    let recovered = false;
    ctx.retryQueue.registerHandler('flaky_job', async () => {
      if (shouldFail) throw new Error('Cloudflare 522');
      recovered = true;
    });

    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const task = await ctx.retryQueue.enqueue(
      { kind: 'flaky_job', payload: {}, initialDelayMs: 0, maxAttempts: 2 },
      t0,
    );

    const r1 = await ctx.retryQueue.processDue(t0);
    expect(r1).toEqual({ succeeded: 0, rescheduled: 1, deadLettered: 0 });

    const r2 = await ctx.retryQueue.processDue(new Date(t0.getTime() + 200));
    expect(r2).toEqual({ succeeded: 0, rescheduled: 0, deadLettered: 1 });
    expect(ctx.retryQueue.getStats()).toEqual({ pending: 0, dead: 1, total: 1 });
    expect(deadEvents).toHaveLength(1);
    expect(deadEvents[0].id).toBe(task.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toContain('Dead-Letter');
    expect(notifications[0].buttons?.[0]?.[0]?.callbackData).toBe(`rq:retry:${task.id}`);

    // Manual recovery from DLQ
    shouldFail = false;
    expect(await ctx.retryQueue.retryDeadTask(task.id, new Date(t0.getTime() + 300))).toBe(true);
    const r3 = await ctx.retryQueue.processDue(new Date(t0.getTime() + 300));
    expect(r3).toEqual({ succeeded: 1, rescheduled: 0, deadLettered: 0 });
    expect(recovered).toBe(true);
    expect(ctx.retryQueue.getStats()).toEqual({ pending: 0, dead: 0, total: 0 });

    // Enqueue two tasks that die, then test retryAllDead & clearDead
    shouldFail = true;
    await ctx.retryQueue.enqueue({ kind: 'flaky_job', payload: { n: 1 }, initialDelayMs: 0, maxAttempts: 1 }, t0);
    await ctx.retryQueue.enqueue({ kind: 'flaky_job', payload: { n: 2 }, initialDelayMs: 0, maxAttempts: 1 }, t0);
    await ctx.retryQueue.processDue(t0);
    expect(ctx.retryQueue.getStats()).toEqual({ pending: 0, dead: 2, total: 2 });

    expect(await ctx.retryQueue.clearDead()).toBe(2);
    expect(ctx.retryQueue.getStats()).toEqual({ pending: 0, dead: 0, total: 0 });

    await ctx.fiber.dispose();
  });

  it('persists queued tasks across service restarts', async () => {
    const dir = makeTempDir();
    const ctx1 = new Context();
    await ctx1.use(StorageService, { baseDir: dir });
    await ctx1.use(PlayerokService, { dryRun: true, enableMaintenanceLoops: false });
    await ctx1.use(RetryQueueService, { enableTimer: false });

    const created = await ctx1.retryQueue.enqueue({
      kind: 'send_message',
      payload: { chatId: 'chat-1', text: 'Persisted key' },
      dedupeKey: 'persist-1',
      initialDelayMs: 0,
    });
    await ctx1.fiber.dispose();

    const ctx2 = new Context();
    await ctx2.use(StorageService, { baseDir: dir });
    await ctx2.use(PlayerokService, { dryRun: true, enableMaintenanceLoops: false });
    await ctx2.use(RetryQueueService, { enableTimer: false });

    const persisted = ctx2.retryQueue.list('pending');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(created.id);
    expect(persisted[0].payload).toEqual({ chatId: 'chat-1', text: 'Persisted key' });

    const res = await ctx2.retryQueue.processDue(new Date(Date.now() + 60_000));
    expect(res).toEqual({ succeeded: 1, rescheduled: 0, deadLettered: 0 });
    expect(ctx2.retryQueue.list()).toHaveLength(0);

    await ctx2.fiber.dispose();
  });

  it('E2E: queues failed auto-delivery & auto-complete on API outage and recovers automatically', async () => {
    const dir = makeTempDir();
    const app = await createApplication({
      dataDir: dir,
      dryRun: true,
      enableTelegram: false,
      enableTimers: false,
      enableInstanceLock: false,
      silentConsole: true,
    });
    await app.start();

    const { ctx } = app;
    const mock = ctx.playerok.transport as MockPlayerokTransport;

    ctx.storage.updateConfig((cfg) => {
      cfg.playerok.auto_complete_deals.enabled = true;
      cfg.playerok.auto_complete_deals.all = true;
    });
    ctx.storage.set('auto_deliveries', [
      {
        keyphrases: ['Steam Key'],
        piece: true,
        goods: ['KEY-FIRST-111', 'KEY-SECOND-222'],
      },
    ]);

    // Simulate temporary PlayerOK API outage for both sendMessage and updateDeal
    const origSend = mock.sendMessage.bind(mock);
    const origUpdateDeal = mock.updateDeal.bind(mock);
    mock.sendMessage = async () => {
      throw new Error('502 Bad Gateway');
    };
    mock.updateDeal = async () => {
      throw new Error('504 Gateway Timeout');
    };

    const deal = await mock.simulateNewDeal({
      buyer: { id: 'buyer-outage', username: 'OutageBuyer' },
      chatId: 'chat-outage',
      itemId: '11111111-1111-1111-1111-111111111111',
    });

    // Key was reserved so it cannot be given to another buyer while retry is pending
    const remainingGoods = ctx.storage.getAutoDeliveries()[0].goods ?? [];
    expect(remainingGoods).toEqual(['KEY-SECOND-222']);
    expect(ctx.storage.isDealDelivered(deal.id)).toBe(true);
    expect(ctx.storage.isDealCompleted(deal.id)).toBe(false);

    // Both send_message and update_deal landed in the retry queue
    const pending = ctx.retryQueue.list('pending');
    expect(pending.map((t) => t.kind).sort()).toEqual(['send_message', 'update_deal']);

    // Restore API availability and process due retry tasks
    mock.sendMessage = origSend;
    mock.updateDeal = origUpdateDeal;

    const future = new Date(Date.now() + 60_000);
    const result = await ctx.retryQueue.processDue(future);
    expect(result).toEqual({ succeeded: 2, rescheduled: 0, deadLettered: 0 });
    expect(ctx.retryQueue.list()).toHaveLength(0);

    // Buyer received the reserved key and deal was marked SENT + completed in idempotency store
    expect(
      mock.sentMessages.some((m) => m.chatId === 'chat-outage' && m.text?.includes('KEY-FIRST-111')),
    ).toBe(true);
    expect(
      mock.updatedDeals.some((u) => u.dealId === deal.id && u.status === ItemDealStatuses.SENT),
    ).toBe(true);
    expect(ctx.storage.isDealCompleted(deal.id)).toBe(true);

    await app.stop();
  });

  it('E2E: queues blacklist auto-refund when updateDeal fails', async () => {
    const dir = makeTempDir();
    const app = await createApplication({
      dataDir: dir,
      dryRun: true,
      enableTelegram: false,
      enableTimers: false,
      enableInstanceLock: false,
      silentConsole: true,
    });
    await app.start();

    const { ctx } = app;
    const mock = ctx.playerok.transport as MockPlayerokTransport;

    ctx.storage.updateConfig((cfg) => {
      cfg.playerok.blacklist.auto_refund = true;
    });
    ctx.blacklist.add('BadBuyer', 'chargeback');

    const origUpdateDeal = mock.updateDeal.bind(mock);
    mock.updateDeal = async () => {
      throw new Error('Network reset');
    };

    const deal = await mock.simulateNewDeal({
      buyer: { id: 'bad-1', username: 'BadBuyer' },
      chatId: 'chat-bad',
      itemId: '11111111-1111-1111-1111-111111111111',
    });

    const queued = ctx.retryQueue.list('pending');
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe('update_deal');
    expect(queued[0].payload).toEqual({
      dealId: deal.id,
      status: ItemDealStatuses.ROLLED_BACK,
    });

    mock.updateDeal = origUpdateDeal;
    const res = await ctx.retryQueue.processDue(new Date(Date.now() + 60_000));
    expect(res).toEqual({ succeeded: 1, rescheduled: 0, deadLettered: 0 });
    expect(
      mock.updatedDeals.some((u) => u.dealId === deal.id && u.status === ItemDealStatuses.ROLLED_BACK),
    ).toBe(true);

    await app.stop();
  });

  it('renders Telegram retry queue screen and main menu entry', () => {
    const menu = renderMainMenu(true);
    const allCallbacks = menu.keyboard.inline_keyboard
      .flat()
      .map((btn) => ('callback_data' in btn ? btn.callback_data : ''));
    expect(allCallbacks).toContain('menu:retry_queue');

    const emptyView = renderRetryQueue([]);
    expect(emptyView.text).toContain('Очередь пуста');

    const view = renderRetryQueue([
      {
        id: 'task-1',
        kind: 'send_message',
        payload: { chatId: 'c1', text: 'hi' },
        attempts: 1,
        maxAttempts: 5,
        nextRunAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        lastError: '503',
        status: 'pending',
      },
      {
        id: 'task-2',
        kind: 'update_deal',
        payload: { dealId: 'd1', status: 'SENT' },
        attempts: 5,
        maxAttempts: 5,
        nextRunAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        lastError: 'timeout',
        status: 'dead',
      },
    ]);
    expect(view.text).toContain('pending): <b>1</b>');
    expect(view.text).toContain('DLQ): <b>1</b>');
    expect(view.text).toContain('task-1');
    expect(view.text).toContain('task-2');
    const rqCallbacks = view.keyboard.inline_keyboard
      .flat()
      .map((btn) => ('callback_data' in btn ? btn.callback_data : ''));
    expect(rqCallbacks).toContain('rq:run');
    expect(rqCallbacks).toContain('rq:retry_dead');
    expect(rqCallbacks).toContain('rq:clear_dead');
    expect(rqCallbacks).toContain('rq:retry:task-2');
    expect(rqCallbacks).toContain('rq:del:task-1');
  });
});
