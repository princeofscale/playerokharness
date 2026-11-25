import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Context,
  StorageService,
  TransactionDirections,
  TransactionOperations,
  TransactionStatuses,
  type Transaction,
} from '@pkh/core';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import { AnalyticsService } from '@pkh/plugin-analytics';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-an-backfill-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tx(partial: Partial<Transaction> & { id: string; value: number }): Transaction {
  return {
    operation: TransactionOperations.WITHDRAW,
    direction: TransactionDirections.OUT,
    status: TransactionStatuses.CONFIRMED,
    createdAt: new Date().toISOString(),
    ...partial,
  } as Transaction;
}

describe('analytics transaction backfill', () => {
  it('counts fees and withdrawals from the transaction history exactly once', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    const mock = new MockPlayerokTransport();
    await ctx.use(PlayerokService, { transport: mock, enableMaintenanceLoops: false });
    await ctx.use(AnalyticsService, { enableBackfill: false });

    mock.transactions.push(
      tx({ id: 'tx-withdraw-1', value: 1000, fee: 0 }),
      tx({
        id: 'tx-fee-1',
        value: 500,
        fee: 25,
        operation: TransactionOperations.DEPOSIT,
        direction: TransactionDirections.IN,
      }),
    );

    const first = await ctx.analytics.backfillTransactions();
    expect(first.counted).toBe(2);

    const summary = ctx.analytics.getSummary({ period: 'all' });
    expect(summary.withdrawn).toBe(1000);
    expect(summary.fees).toBe(25);
    expect(summary.net).toBe(summary.gross - 1025);

    // Idempotent: the same history must not be counted twice.
    const second = await ctx.analytics.backfillTransactions();
    expect(second.counted).toBe(0);
    expect(ctx.analytics.getSummary({ period: 'all' }).withdrawn).toBe(1000);

    await ctx.fiber.dispose();
  });

  it('survives an unavailable transaction endpoint', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    const mock = new MockPlayerokTransport();
    mock.getTransactions = async () => {
      throw new Error('HTTP 503');
    };
    await ctx.use(PlayerokService, { transport: mock, enableMaintenanceLoops: false });
    await ctx.use(AnalyticsService, { enableBackfill: false });

    await expect(ctx.analytics.backfillTransactions()).resolves.toEqual({ counted: 0 });

    await ctx.fiber.dispose();
  });
});
