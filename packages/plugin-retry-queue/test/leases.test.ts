import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Context, ItemDealStatuses, StorageService } from '@pkh/core';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import {
  computeBackoffMs,
  currentWorkerId,
  nextDelay,
  RetryQueueService,
  type RetryQueueConfig,
  type RetryQueueStore,
  type RetryTask,
} from '@pkh/plugin-retry-queue';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-rq-leases-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Fixed clock for every lease/retention test: no wall-clock flakiness. */
const T0 = new Date('2026-03-01T00:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface BootedQueue {
  ctx: Context;
  queue: RetryQueueService;
}

/**
 * Boots a standalone queue on its own Context. Two calls with the same directory model two
 * processes sharing one data directory - the situation the persistent lease exists for.
 */
async function bootQueue(dir: string, config: RetryQueueConfig = {}): Promise<BootedQueue> {
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: dir });
  await ctx.use(PlayerokService, { dryRun: true, enableMaintenanceLoops: false });
  await ctx.use(RetryQueueService, { enableTimer: false, ...config });
  return { ctx, queue: ctx.retryQueue };
}

interface TaskOverrides {
  status?: RetryTask['status'];
  attempts?: number;
  maxAttempts?: number;
  createdAt?: string;
  nextRunAt?: string;
  deadAt?: string;
  claimedAt?: string;
  claimedBy?: string;
}

function makeTask(id: string, kind: string, overrides: TaskOverrides = {}): RetryTask {
  return {
    id,
    kind,
    payload: {},
    attempts: overrides.attempts ?? 0,
    maxAttempts: overrides.maxAttempts ?? 5,
    nextRunAt: overrides.nextRunAt ?? T0.toISOString(),
    createdAt: overrides.createdAt ?? T0.toISOString(),
    status: overrides.status ?? 'pending',
    claimedAt: overrides.claimedAt,
    claimedBy: overrides.claimedBy,
    deadAt: overrides.deadAt,
  };
}

/** Writes the queue store directly, as a crashed process would have left it. */
function seedStore(ctx: Context, tasks: RetryTask[]): void {
  ctx.storage.set<RetryQueueStore>('retry_queue', { tasks });
}

interface Deferred {
  promise: Promise<void>;
  release: () => void;
}

function deferred(): Deferred {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const iso = (offsetMs: number): string => new Date(T0.getTime() + offsetMs).toISOString();

describe('@pkh/plugin-retry-queue leases & retention', () => {
  it('claim stops a second concurrent poll pass from running the same task', async () => {
    const dir = makeTempDir();
    const first = await bootQueue(dir);
    const second = await bootQueue(dir);

    const gate = deferred();
    let calls = 0;
    const handler = async (): Promise<void> => {
      calls += 1;
      await gate.promise;
    };
    first.queue.registerHandler('slow_job', handler);
    second.queue.registerHandler('slow_job', handler);

    await first.queue.enqueue(
      { kind: 'slow_job', payload: { orderId: 'o-1' }, initialDelayMs: 0 },
      T0,
    );

    const passA = first.queue.processDue(T0);
    const passB = second.queue.processDue(T0);

    await delay(50);

    // The lease is persisted BEFORE the handler finishes, so the other pass has nothing to do.
    expect(calls).toBe(1);
    expect(second.queue.list('processing')).toHaveLength(1);
    const leased = second.queue.list('processing')[0];
    expect(leased.claimedAt).toBe(T0.toISOString());
    expect(leased.claimedBy).toBe(currentWorkerId());
    expect(leased.claimedBy).toMatch(/^[0-9]+@.+$/);

    gate.release();
    const [resultA, resultB] = await Promise.all([passA, passB]);

    expect(resultA.succeeded + resultB.succeeded).toBe(1);
    expect(resultA.rescheduled + resultB.rescheduled).toBe(0);
    expect(resultA.deadLettered + resultB.deadLettered).toBe(0);
    expect(calls).toBe(1);
    expect(first.queue.list()).toHaveLength(0);

    await first.ctx.fiber.dispose();
    await second.ctx.fiber.dispose();
  });

  it('reclaims an expired lease exactly once', async () => {
    const dir = makeTempDir();
    const leaseMs = 1000;
    const first = await bootQueue(dir, { leaseMs });
    const second = await bootQueue(dir, { leaseMs });

    const gate = deferred();
    let calls = 0;
    const handler = async (): Promise<void> => {
      calls += 1;
      await gate.promise;
    };
    first.queue.registerHandler('recover_job', handler);
    second.queue.registerHandler('recover_job', handler);

    let reclaims = 0;
    first.ctx.on('retry/lease-reclaimed', () => {
      reclaims += 1;
    });
    second.ctx.on('retry/lease-reclaimed', () => {
      reclaims += 1;
    });

    const task = await first.queue.enqueue(
      { kind: 'recover_job', payload: {}, initialDelayMs: 0 },
      T0,
    );
    // A process claimed the task and died before completing the attempt.
    seedStore(first.ctx, [
      makeTask(task.id, 'recover_job', {
        status: 'processing',
        claimedAt: T0.toISOString(),
        claimedBy: '424242@dead-host',
      }),
    ]);

    // Still inside the lease window: the stuck task must be left alone.
    const early = await first.queue.processDue(new Date(T0.getTime() + leaseMs - 1));
    expect(early).toEqual({ succeeded: 0, rescheduled: 0, deadLettered: 0 });
    expect(calls).toBe(0);
    expect(reclaims).toBe(0);
    expect(first.queue.getStats(true).expiredLeases).toBe(0);
    expect(first.queue.list('processing')).toHaveLength(1);

    // Lease expired: exactly one of the two competing passes may win it.
    const at = new Date(T0.getTime() + leaseMs);
    const passA = first.queue.processDue(at);
    const passB = second.queue.processDue(at);

    await delay(50);
    expect(calls).toBe(1);

    gate.release();
    const [resultA, resultB] = await Promise.all([passA, passB]);

    expect(resultA.succeeded + resultB.succeeded).toBe(1);
    expect(reclaims).toBe(1);
    const expiredLeases =
      (first.queue.getStats(true).expiredLeases ?? 0) + (second.queue.getStats(true).expiredLeases ?? 0);
    expect(expiredLeases).toBe(1);
    expect(calls).toBe(1);
    expect(first.queue.list()).toHaveLength(0);

    await first.ctx.fiber.dispose();
    await second.ctx.fiber.dispose();
  });

  it('prunes stale dead tasks and enforces the size cap without dropping live work', async () => {
    const dir = makeTempDir();
    const { ctx, queue } = await bootQueue(dir, { deadRetentionDays: 14, maxTasks: 3 });

    seedStore(ctx, [
      makeTask('dead-old-1', 'noop', { status: 'dead', deadAt: iso(-40 * DAY) }),
      makeTask('dead-old-2', 'noop', { status: 'dead', deadAt: iso(-30 * DAY) }),
      makeTask('dead-recent-1', 'noop', { status: 'dead', deadAt: iso(-4 * HOUR) }),
      makeTask('dead-recent-2', 'noop', { status: 'dead', deadAt: iso(-3 * HOUR) }),
      makeTask('dead-recent-3', 'noop', { status: 'dead', deadAt: iso(-2 * HOUR) }),
      makeTask('dead-recent-4', 'noop', { status: 'dead', deadAt: iso(-1 * HOUR) }),
      makeTask('pending-seeded', 'noop', { nextRunAt: iso(HOUR) }),
    ]);

    // Enqueue must stay cheap: retention only runs inside the poll pass.
    const queued = await queue.enqueue(
      { kind: 'noop', payload: {}, initialDelayMs: MINUTE },
      T0,
    );
    expect(queue.list('dead')).toHaveLength(6);
    expect(queue.getStats()).toEqual({ pending: 2, dead: 6, total: 8 });

    const result = await queue.processDue(T0);
    expect(result).toEqual({ succeeded: 0, rescheduled: 0, deadLettered: 0 });

    // Two dead tasks aged out, then the oldest dead tasks made room for the two pending ones.
    expect(queue.list('dead').map((task) => task.id)).toEqual(['dead-recent-4']);
    const pendingIds = queue.list('pending').map((task) => task.id).sort();
    expect(pendingIds).toEqual(['pending-seeded', queued.id].sort());
    expect(queue.list()).toHaveLength(3);
    expect(queue.getStats()).toEqual({ pending: 2, dead: 1, total: 3 });
    expect(queue.getStats(true)).toEqual({
      pending: 2,
      dead: 1,
      total: 3,
      processing: 0,
      expiredLeases: 0,
      pruned: 5,
    });

    // A second idle pass is a no-op: nothing left to prune, counter unchanged.
    await queue.processDue(T0);
    expect(queue.getStats(true).pruned).toBe(5);
    expect(queue.list()).toHaveLength(3);

    await ctx.fiber.dispose();
  });

  it('dead-letters update_deal with an invalid status instead of casting it', async () => {
    const dir = makeTempDir();
    const { ctx, queue } = await bootQueue(dir);
    const mock = ctx.playerok.transport as MockPlayerokTransport;

    const deadLetters: RetryTask[] = [];
    ctx.on('retry/dead-letter', (task) => {
      deadLetters.push(task);
    });

    await queue.enqueue(
      {
        kind: 'update_deal',
        payload: { dealId: 'deal-invalid', status: 'DELIVERED_SOMEWHERE' },
        initialDelayMs: 0,
      },
      T0,
    );

    const result = await queue.processDue(T0);
    expect(result).toEqual({ succeeded: 0, rescheduled: 0, deadLettered: 1 });

    const dead = queue.list('dead');
    expect(dead).toHaveLength(1);
    expect(dead[0].status).toBe('dead');
    expect(dead[0].attempts).toBe(1);
    expect(dead[0].lastError).toContain('недопустимый статус сделки');
    expect(dead[0].lastError).toContain('DELIVERED_SOMEWHERE');
    expect(deadLetters).toHaveLength(1);
    expect(mock.updatedDeals).toHaveLength(0);

    // The guard accepts real ItemDealStatuses values: it only rejects unknown strings.
    const deal = await mock.simulateNewDeal({
      buyer: { id: 'buyer-ok', username: 'OkBuyer' },
      chatId: 'chat-ok',
      itemId: '11111111-1111-1111-1111-111111111111',
    });
    await queue.enqueue(
      {
        kind: 'update_deal',
        payload: { dealId: deal.id, status: ItemDealStatuses.SENT },
        initialDelayMs: 0,
      },
      T0,
    );

    const ok = await queue.processDue(T0);
    expect(ok).toEqual({ succeeded: 1, rescheduled: 0, deadLettered: 0 });
    expect(mock.updatedDeals).toEqual([{ dealId: deal.id, status: ItemDealStatuses.SENT }]);
    expect(ctx.storage.isDealCompleted(deal.id)).toBe(true);

    await ctx.fiber.dispose();
  });

  it('keeps jittered backoff within +/-20% of the deterministic value', () => {
    // The pure function must stay byte-identical for callers that assert exact values.
    expect(computeBackoffMs(1, 1000, 10_000)).toBe(1000);
    expect(computeBackoffMs(2, 1000, 10_000)).toBe(2000);
    expect(computeBackoffMs(5, 1000, 10_000)).toBe(10_000);

    for (const attempts of [1, 2, 3, 4, 5]) {
      const base = computeBackoffMs(attempts, 1000, 8000);
      expect(nextDelay(attempts, 1000, 8000, () => 0)).toBe(base * 0.8);
      expect(nextDelay(attempts, 1000, 8000, () => 1)).toBe(base * 1.2);
      expect(nextDelay(attempts, 1000, 8000, () => 0.5)).toBe(base);

      for (let i = 0; i < 100; i += 1) {
        const jittered = nextDelay(attempts, 1000, 8000);
        expect(jittered).toBeGreaterThanOrEqual(base * 0.8);
        expect(jittered).toBeLessThanOrEqual(base * 1.2);
      }
    }

    // Out-of-range samples are clamped instead of exploding the schedule.
    expect(nextDelay(1, 1000, 8000, () => 5)).toBe(800 + 400);
    expect(nextDelay(1, 1000, 8000, () => -1)).toBe(800);
  });
});
