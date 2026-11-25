import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Context,
  ItemDealStatuses,
  StorageService,
  TransactionDirections,
  TransactionOperations,
  TransactionStatuses,
  type ItemDeal,
  type Transaction,
} from '@pkh/core';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import {
  AnalyticsService,
  analyticsDayKey,
  transactionMarker,
  type AnalyticsConfig,
  type AnalyticsStore,
} from '@pkh/plugin-analytics';

const tempDirs: string[] = [];
const contexts: Context[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-profit-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Fixed clock: every window assertion is calendar-deterministic. */
const NOW = new Date('2026-03-15T12:00:00.000Z');
const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function makeDeal(id: string, options: { price?: number; createdAt?: string } = {}): ItemDeal {
  const price = options.price ?? 100;
  return {
    id,
    status: ItemDealStatuses.PAID,
    user: { id: 'buyer-1', username: 'buyer' },
    item: { id: 'item-1', slug: 'item-1', name: 'Товар', price, rawPrice: price },
    createdAt: options.createdAt ?? NOW.toISOString(),
  };
}

interface TransactionOptions {
  value?: number;
  fee?: number;
  operation?: TransactionOperations;
  direction?: TransactionDirections;
  status?: TransactionStatuses;
  createdAt?: string;
}

function makeTransaction(id: string, options: TransactionOptions = {}): Transaction {
  const operation = options.operation ?? TransactionOperations.SELL;
  return {
    id,
    operation,
    direction:
      options.direction ??
      (operation === TransactionOperations.WITHDRAW
        ? TransactionDirections.OUT
        : TransactionDirections.IN),
    providerId: null,
    status: options.status ?? TransactionStatuses.CONFIRMED,
    value: options.value ?? 100,
    // `Transaction.fee` is optional, never null: an absent fee means "no commission".
    fee: options.fee,
    createdAt: options.createdAt ?? NOW.toISOString(),
  };
}

async function makeContext(dir: string): Promise<Context> {
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: dir });
  await ctx.use(PlayerokService, {
    transport: new MockPlayerokTransport(),
    enableMaintenanceLoops: false,
  });
  contexts.push(ctx);
  return ctx;
}

interface BootedAnalytics {
  ctx: Context;
  analytics: AnalyticsService;
  dir: string;
}

async function bootAnalytics(
  config: AnalyticsConfig = { enableBackfill: false },
): Promise<BootedAnalytics> {
  const dir = makeTempDir();
  const ctx = await makeContext(dir);
  await ctx.use(AnalyticsService, config);
  return { ctx, analytics: ctx.analytics, dir };
}

function readStore(ctx: Context): AnalyticsStore {
  return ctx.storage.get<AnalyticsStore>('analytics');
}

/** Reads the on-disk store: the profit buckets must survive a restart, not just live in memory. */
function readStoreFromDisk(dir: string): AnalyticsStore {
  return JSON.parse(
    fs.readFileSync(path.join(dir, 'bot_data', 'analytics.json'), 'utf8'),
  ) as AnalyticsStore;
}

describe('@pkh/plugin-analytics profit (fees, withdrawals, net)', () => {
  it('counts a withdrawal event into withdrawn, lowers net and keeps gross/orders intact', async () => {
    expect(AnalyticsService.provide).toBe('analytics');
    const { ctx, analytics, dir } = await bootAnalytics();

    // The event path stamps its own clock, so this test lives on the real day
    // bucket: one captured instant keeps both writes on the same day key.
    const realNow = new Date();
    const dayKey = analyticsDayKey(realNow);
    await analytics.recordNewDeal(
      makeDeal('deal-1', { price: 1000, createdAt: realNow.toISOString() }),
      realNow,
    );
    await ctx.parallel('withdrawal/requested', {
      transactionId: 'trx-w1',
      amount: 250,
      provider: 'SBP',
    });

    expect(analytics.getSummary({ period: 'day', now: realNow })).toEqual({
      gross: 1000,
      fees: 0,
      withdrawn: 250,
      net: 750,
      // Legacy fields stay exactly as they were before net profit existed.
      revenue: 1000,
      orders: 1,
      completed: 0,
      cancelled: 0,
      avgOrder: 1000,
    });

    expect(analytics.getDailySeries(1, realNow)).toEqual([
      { date: dayKey, revenue: 1000, orders: 1, net: 750 },
    ]);

    const bucket = readStore(ctx).days[dayKey];
    expect(bucket?.withdrawn).toBe(250);
    expect(bucket?.fees).toBe(0);
    expect(bucket?.revenue).toBe(1000);
    expect(readStore(ctx).seenDeals).toContain(transactionMarker('trx-w1'));

    const onDisk = readStoreFromDisk(dir);
    expect(onDisk.days[dayKey]?.withdrawn).toBe(250);
    expect(onDisk.days[dayKey]?.fees).toBe(0);
  });

  it('counts a fee transaction into fees and a WITHDRAW transaction into withdrawn', async () => {
    const { analytics } = await bootAnalytics();
    await analytics.recordNewDeal(makeDeal('deal-1', { price: 1000 }), NOW);

    // A sale fee is bucketed on the transaction's own day, not on the sale day.
    expect(
      await analytics.recordTransaction(
        makeTransaction('trx-fee-1', { value: 1000, fee: 100, createdAt: daysAgo(2) }),
        NOW,
      ),
    ).toBe(true);
    // A withdrawal carries both a fee and the amount moved out of the balance.
    expect(
      await analytics.recordTransaction(
        makeTransaction('trx-w1', {
          operation: TransactionOperations.WITHDRAW,
          value: 300,
          fee: 5,
          status: TransactionStatuses.PENDING,
          createdAt: daysAgo(1),
        }),
        NOW,
      ),
    ).toBe(true);

    expect(analytics.getSummary({ period: 'all', now: NOW })).toEqual({
      gross: 1000,
      fees: 105,
      withdrawn: 300,
      net: 595,
      revenue: 1000,
      orders: 1,
      completed: 0,
      cancelled: 0,
      avgOrder: 1000,
    });

    expect(analytics.getDailySeries(3, NOW)).toEqual([
      { date: '2026-03-13', revenue: 0, orders: 0, net: -100 },
      { date: '2026-03-14', revenue: 0, orders: 0, net: -305 },
      { date: '2026-03-15', revenue: 1000, orders: 1, net: 1000 },
    ]);
  });

  it('ignores a replayed transaction id across the event and the API path', async () => {
    const { ctx, analytics } = await bootAnalytics();

    await ctx.parallel('withdrawal/requested', {
      transactionId: 'trx-dup',
      amount: 250,
      provider: 'SBP',
    });
    // Same id again through the event and through every public entry point.
    await ctx.parallel('withdrawal/requested', {
      transactionId: 'trx-dup',
      amount: 250,
      provider: 'SBP',
    });
    expect(await analytics.recordWithdrawal({ transactionId: 'trx-dup', amount: 250 }, NOW)).toBe(
      false,
    );
    expect(
      await analytics.recordTransaction(
        makeTransaction('trx-dup', {
          operation: TransactionOperations.WITHDRAW,
          value: 250,
          fee: 10,
        }),
        NOW,
      ),
    ).toBe(false);

    // A fee-bearing transaction replayed twice is counted once too.
    const feeTx = makeTransaction('trx-fee-1', { value: 1000, fee: 50 });
    expect(await analytics.recordTransaction(feeTx, NOW)).toBe(true);
    expect(await analytics.recordTransaction(feeTx, NOW)).toBe(false);

    const summary = analytics.getSummary({ period: 'all', now: NOW });
    expect(summary.withdrawn).toBe(250);
    expect(summary.fees).toBe(50);
    expect(summary.net).toBe(-300);

    const markers = readStore(ctx).seenDeals.filter(
      (marker) => marker === transactionMarker('trx-dup'),
    );
    expect(markers).toEqual([transactionMarker('trx-dup')]);
  });

  it('ignores a rolled-back or failed transaction: no fee, no withdrawal, no bucket', async () => {
    const { ctx, analytics } = await bootAnalytics();

    expect(
      await analytics.recordTransaction(
        makeTransaction('trx-rb', {
          operation: TransactionOperations.WITHDRAW,
          value: 500,
          fee: 5,
          status: TransactionStatuses.ROLLED_BACK,
        }),
        NOW,
      ),
    ).toBe(false);
    expect(
      await analytics.recordTransaction(
        makeTransaction('trx-failed', { value: 400, fee: 20, status: TransactionStatuses.FAILED }),
        NOW,
      ),
    ).toBe(false);

    expect(analytics.getSummary({ period: 'all', now: NOW })).toEqual({
      gross: 0,
      fees: 0,
      withdrawn: 0,
      net: 0,
      revenue: 0,
      orders: 0,
      completed: 0,
      cancelled: 0,
      avgOrder: 0,
    });
    expect(readStore(ctx).days['2026-03-15']).toBeUndefined();
  });

  it('windows fees and withdrawals by calendar day like orders', async () => {
    const { analytics } = await bootAnalytics();
    await analytics.recordNewDeal(makeDeal('deal-today', { price: 400 }), NOW);
    await analytics.recordNewDeal(makeDeal('deal-3d', { price: 600, createdAt: daysAgo(3) }), NOW);
    await analytics.recordTransaction(
      makeTransaction('trx-fee-today', { value: 400, fee: 40 }),
      NOW,
    );
    await analytics.recordWithdrawal(
      { transactionId: 'trx-w-old', amount: 100 },
      new Date(NOW.getTime() - 2 * DAY_MS),
    );

    const day = analytics.getSummary({ period: 'day', now: NOW });
    expect(day).toMatchObject({ gross: 400, fees: 40, withdrawn: 0, net: 360, orders: 1 });
    const week = analytics.getSummary({ period: 'week', now: NOW });
    expect(week).toMatchObject({ gross: 1000, fees: 40, withdrawn: 100, net: 860, orders: 2 });
    expect(analytics.getSummary({ period: 'all', now: NOW })).toEqual(week);
    expect(week.net).toBe(week.gross - week.fees - week.withdrawn);
  });
});
