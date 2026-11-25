import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Context, StorageService } from '@pkh/core';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import { RetryQueueService, type RetryQueueConfig, type RetryQueueStore } from '@pkh/plugin-retry-queue';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-rq-lifecycle-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const T0 = new Date('2026-03-01T00:00:00.000Z');

interface BootedQueue {
  ctx: Context;
  queue: RetryQueueService;
}

async function bootQueue(dir: string, config: RetryQueueConfig = {}): Promise<BootedQueue> {
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: dir });
  await ctx.use(PlayerokService, {
    dryRun: true,
    enableMaintenanceLoops: false,
    transport: new MockPlayerokTransport(),
  });
  await ctx.use(RetryQueueService, { enableTimer: false, ...config });
  return { ctx, queue: ctx.retryQueue };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Listener isolation and single-flight guarantees.
 *
 * Every case below used to corrupt durable state or double a side effect: a throwing event
 * listener aborted the rest of a poll pass, a successful attempt was re-marked as failed by
 * its own success event, and a second copy of a leased task could be enqueued/executed.
 */
describe('@pkh/plugin-retry-queue: listener isolation & single flight', () => {
  it('keeps a persisted task when a retry/enqueued listener throws', async () => {
    const { ctx, queue } = await bootQueue(makeTempDir());
    ctx.on('retry/enqueued', () => {
      throw new Error('listener boom');
    });

    // The task is written before the event fires, so the caller MUST see a resolved enqueue:
    // auto-delivery treats a rejection as "not queued" and returns the reserved key to stock,
    // which would sell the same key twice (once from stock, once by the pending retry).
    const task = await queue.enqueue({ kind: 'noop', payload: { n: 1 }, initialDelayMs: 0 }, T0);

    expect(task.id).toBeTruthy();
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0].id).toBe(task.id);

    await ctx.fiber.dispose();
  });

  it('finishes the pass when dead-letter and notify listeners throw', async () => {
    const { ctx, queue } = await bootQueue(makeTempDir());
    let healthyCalls = 0;
    let dyingCalls = 0;

    queue.registerHandler('healthy_job', () => {
      healthyCalls += 1;
    });
    queue.registerHandler('dying_job', () => {
      dyingCalls += 1;
      throw new Error('permanent outage');
    });
    ctx.on('retry/dead-letter', () => {
      throw new Error('dlq listener boom');
    });
    ctx.on('notify/log', () => {
      throw new Error('telegram is down');
    });

    await queue.enqueue(
      { kind: 'dying_job', payload: {}, initialDelayMs: 0, maxAttempts: 1 },
      T0,
    );
    await queue.enqueue({ kind: 'healthy_job', payload: {}, initialDelayMs: 0 }, T0);

    // One broken listener must not cancel the tasks queued behind it: before the fix the
    // pass rejected on the dead-letter notification and healthy_job was skipped entirely.
    const result = await queue.processDue(T0);

    expect(dyingCalls).toBe(1);
    expect(healthyCalls).toBe(1);
    expect(result).toEqual({ succeeded: 1, rescheduled: 0, deadLettered: 1 });
    expect(queue.list('dead')).toHaveLength(1);
    expect(queue.list()).toHaveLength(1);

    await ctx.fiber.dispose();
  });

  it('reports a successful attempt once when a retry/succeeded listener throws', async () => {
    const { ctx, queue } = await bootQueue(makeTempDir());
    let calls = 0;
    queue.registerHandler('ok_job', () => {
      calls += 1;
    });
    ctx.on('retry/succeeded', () => {
      throw new Error('listener boom');
    });

    await queue.enqueue({ kind: 'ok_job', payload: {}, initialDelayMs: 0 }, T0);
    const result = await queue.processDue(T0);

    // Before the fix the throw fell into the failure branch, which re-counted the removed
    // task as rescheduled (succeeded 1 + rescheduled 1 for one task) and logged "не удалась".
    expect(result).toEqual({ succeeded: 1, rescheduled: 0, deadLettered: 0 });
    expect(calls).toBe(1);
    expect(queue.list()).toHaveLength(0);

    await ctx.fiber.dispose();
  });

  it('does not enqueue a second copy of a task that is being processed', async () => {
    const { ctx, queue } = await bootQueue(makeTempDir());
    const gate = deferred();
    let calls = 0;
    queue.registerHandler('send_message_like', async () => {
      calls += 1;
      await gate.promise;
    });

    const first = await queue.enqueue(
      { kind: 'send_message_like', payload: { chatId: 'c1', text: 'KEY-1' }, dedupeKey: 'delivery:deal-1:0', initialDelayMs: 0 },
      T0,
    );

    const pass = queue.processDue(T0);
    await delay(30);
    expect(queue.list()[0].status).toBe('processing');

    // The retry-queue statement: the same logical delivery is already in flight.
    const second = await queue.enqueue(
      { kind: 'send_message_like', payload: { chatId: 'c1', text: 'KEY-1' }, dedupeKey: 'delivery:deal-1:0', initialDelayMs: 0 },
      T0,
    );

    expect(second.id).toBe(first.id);
    expect(queue.list()).toHaveLength(1);

    gate.release();
    await pass;

    expect(calls).toBe(1);
    expect(queue.list()).toHaveLength(0);

    await ctx.fiber.dispose();
  });

  it('refuses to resurrect a task that a poll pass currently holds', async () => {
    const { ctx, queue } = await bootQueue(makeTempDir());
    const gate = deferred();
    let calls = 0;
    queue.registerHandler('slow_job', async () => {
      calls += 1;
      await gate.promise;
    });

    const task = await queue.enqueue({ kind: 'slow_job', payload: {}, initialDelayMs: 0 }, T0);
    const pass = queue.processDue(T0);
    await delay(30);
    expect(queue.list()[0].status).toBe('processing');

    // A stale "♻️ retry" button (or a double tap) must not queue the leased task again.
    expect(await queue.retryDeadTask(task.id, T0)).toBe(false);
    expect(queue.list()[0].status).toBe('processing');

    gate.release();
    await pass;

    expect(calls).toBe(1);
    expect(queue.list()).toHaveLength(0);

    await ctx.fiber.dispose();
  });

  it('does not retry a finished attempt when the queue write fails afterwards', async () => {
    const { ctx, queue } = await bootQueue(makeTempDir());
    let calls = 0;
    let armed = false;

    const originalSet = ctx.storage.set.bind(ctx.storage);
    ctx.storage.set = function patchedSet<T>(name: string, value: T): T {
      if (armed && name === 'retry_queue') {
        armed = false;
        throw new Error('disk full');
      }
      return originalSet(name, value);
    };
    queue.registerHandler('finish_job', () => {
      calls += 1;
      armed = true;
    });

    const task = await queue.enqueue({ kind: 'finish_job', payload: {}, initialDelayMs: 0 }, T0);
    const result = await queue.processDue(T0);

    // The handler ran, so the side effect happened: a failed removal must not reschedule the
    // task (the next pass would send/bump/publish a second time).
    expect(result).toEqual({ succeeded: 1, rescheduled: 0, deadLettered: 0 });
    expect(calls).toBe(1);
    const stored = ctx.storage.get<RetryQueueStore>('retry_queue').tasks.find((t) => t.id === task.id);
    expect(stored?.attempts).toBe(0);

    await ctx.fiber.dispose();
  });
});
