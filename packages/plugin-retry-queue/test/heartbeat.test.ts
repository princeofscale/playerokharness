import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Context, StorageService, TransactionProviderIds } from '@pkh/core';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import { RetryQueueService } from '@pkh/plugin-retry-queue';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-rq-hb-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  ctx: Context;
  mock: MockPlayerokTransport;
}

async function makeHarness(dir: string, leaseMs: number): Promise<Harness> {
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: dir });
  const mock = new MockPlayerokTransport();
  await ctx.use(PlayerokService, { transport: mock, enableMaintenanceLoops: false });
  await ctx.use(RetryQueueService, { enableTimer: false, leaseMs });
  return { ctx, mock };
}

describe('retry queue lease heartbeat', () => {
  it('keeps renewing the lease of a long-running handler so nobody reclaims it', async () => {
    const dir = makeTempDir();
    // Generous margins on purpose: the suite runs many files in parallel, so a tight
    // lease would make this test flaky instead of proving the heartbeat.
    const leaseMs = 1_200;
    const a = await makeHarness(dir, leaseMs);
    const b = await makeHarness(dir, leaseMs);

    let calls = 0;
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow = async (): Promise<void> => {
      calls += 1;
      started = true;
      await gate;
    };
    a.ctx.retryQueue.registerHandler('slow_op', slow);
    b.ctx.retryQueue.registerHandler('slow_op', slow);

    await a.ctx.retryQueue.enqueue({ kind: 'slow_op', payload: {}, initialDelayMs: 0 });
    const due = new Date(Date.now() + 1_000);

    const firstPass = a.ctx.retryQueue.processDue(due);
    while (!started) await sleep(10);

    const initialClaim = a.ctx.retryQueue.list()[0]?.claimedAt;
    expect(initialClaim).toBeTruthy();

    // Longer than the whole lease: without a heartbeat the task would look abandoned.
    await sleep(leaseMs + 600);

    const renewed = a.ctx.retryQueue.list()[0];
    expect(renewed?.status).toBe('processing');
    expect(renewed?.claimedAt).toBeTruthy();
    expect(Date.parse(renewed!.claimedAt!)).toBeGreaterThan(Date.parse(initialClaim!));

    // A second instance must not be able to take it over while it is still running.
    const secondResult = await b.ctx.retryQueue.processDue(due);
    expect(secondResult.succeeded).toBe(0);
    expect(calls).toBe(1);

    release();
    const firstResult = await firstPass;
    expect(firstResult.succeeded).toBe(1);
    expect(calls).toBe(1);

    await a.ctx.fiber.dispose();
    await b.ctx.fiber.dispose();
  });
});

describe('retry queue withdrawal handler', () => {
  it('retries a withdrawal through the queue and records the request', async () => {
    const { ctx, mock } = await makeHarness(makeTempDir(), 60_000);

    await ctx.retryQueue.enqueue({
      kind: 'request_withdrawal',
      payload: {
        provider: TransactionProviderIds.SBP,
        account: '+79990000000',
        value: 1500,
        sbpBankMemberId: 'bank-1',
      },
      initialDelayMs: 0,
    });

    const result = await ctx.retryQueue.processDue(new Date(Date.now() + 1_000));

    expect(result.succeeded).toBe(1);
    expect(mock.withdrawalRequests).toHaveLength(1);
    expect(mock.withdrawalRequests[0]).toMatchObject({
      account: '+79990000000',
      value: 1500,
      sbpBankMemberId: 'bank-1',
    });
    expect(ctx.retryQueue.list()).toHaveLength(0);

    await ctx.fiber.dispose();
  });

  it('dead-letters an invalid withdrawal payload without calling the API', async () => {
    const { ctx, mock } = await makeHarness(makeTempDir(), 60_000);

    await ctx.retryQueue.enqueue({
      kind: 'request_withdrawal',
      payload: { provider: 'bitcoin', account: '+79990000000', value: 1500 },
      initialDelayMs: 0,
    });

    const result = await ctx.retryQueue.processDue(new Date(Date.now() + 1_000));

    expect(result.deadLettered).toBe(1);
    expect(mock.withdrawalRequests).toHaveLength(0);
    const stored = ctx.retryQueue.list('dead');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.lastError).toContain('провайдер');

    await ctx.fiber.dispose();
  });
});
