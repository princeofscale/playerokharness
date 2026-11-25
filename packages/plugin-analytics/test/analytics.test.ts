import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChatTypes,
  Context,
  EventTypes,
  ItemDealStatuses,
  StorageService,
  type CachedOrders,
  type DealEvent,
  type ItemDeal,
} from '@pkh/core';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import {
  ANALYTICS_MAX_SEEN_DEALS,
  ANALYTICS_RETENTION_DAYS,
  AnalyticsService,
  analyticsDayKey,
  orderMarker,
  statusMarker,
  type AnalyticsConfig,
  type AnalyticsStore,
} from '@pkh/plugin-analytics';

const tempDirs: string[] = [];
const contexts: Context[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-analytics-'));
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

/** Fixed clock: every window/retention assertion is calendar-deterministic. */
const NOW = new Date('2026-03-15T12:00:00.000Z');
const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

interface DealOptions {
  price?: number;
  itemId?: string;
  itemName?: string;
  createdAt?: string;
  status?: ItemDealStatuses;
}

function makeDeal(id: string, options: DealOptions = {}): ItemDeal {
  const price = options.price ?? 100;
  const itemId = options.itemId ?? 'item-1';
  return {
    id,
    status: options.status ?? ItemDealStatuses.PAID,
    user: { id: 'buyer-1', username: 'buyer' },
    item: {
      id: itemId,
      slug: itemId,
      name: options.itemName ?? 'Товар',
      price,
      rawPrice: price,
    },
    createdAt: options.createdAt ?? NOW.toISOString(),
  };
}

function makeDealEvent(
  deal: ItemDeal,
  type: DealEvent['type'] = EventTypes.NEW_DEAL,
): DealEvent {
  return {
    type,
    chat: { id: 'chat-1', type: ChatTypes.PM, users: [] },
    timestamp: NOW.getTime(),
    deal,
  };
}

/** Storage + Playerok only: the analytics store must be registered by the service under test. */
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

describe('@pkh/plugin-analytics persistent sales analytics', () => {
  it('records a NEW_DEAL under the deal createdAt day and persists it to bot_data/analytics.json', async () => {
    expect(AnalyticsService.provide).toBe('analytics');
    expect(AnalyticsService.inject).toEqual(['storage', 'playerok']);
    const { ctx, analytics, dir } = await bootAnalytics();

    await ctx.parallel(
      'playerok/new-deal',
      makeDealEvent(makeDeal('deal-1', { price: 150, createdAt: daysAgo(2) })),
    );

    expect(analytics.getSummary({ period: 'all', now: NOW })).toEqual({
      gross: 150,
      fees: 0,
      withdrawn: 0,
      net: 150,
      revenue: 150,
      orders: 1,
      completed: 0,
      cancelled: 0,
      avgOrder: 150,
    });

    const series = analytics.getDailySeries(5, NOW);
    expect(series.map((point) => point.date)).toEqual([
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
      '2026-03-14',
      '2026-03-15',
    ]);
    expect(series[2]).toEqual({ date: '2026-03-13', revenue: 150, orders: 1, net: 150 });
    expect(series[4]).toEqual({ date: '2026-03-15', revenue: 0, orders: 0, net: 0 });

    expect(ctx.storage.getStorePath('analytics')).toBe(
      path.join(dir, 'bot_data', 'analytics.json'),
    );
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, 'bot_data', 'analytics.json'), 'utf8'),
    ) as AnalyticsStore;
    expect(onDisk.days['2026-03-13']?.orders).toBe(1);
    expect(onDisk.days['2026-03-13']?.items['item-1']).toEqual({
      name: 'Товар',
      qty: 1,
      revenue: 150,
    });
    // The event path stamps updatedAt with the real clock; the bucket day comes from the deal.
    expect(Number.isNaN(Date.parse(onDisk.updatedAt))).toBe(false);
  });

  it('does not double count a duplicate NEW_DEAL', async () => {
    const { ctx, analytics } = await bootAnalytics();
    const event = makeDealEvent(makeDeal('deal-1', { price: 150 }));

    await ctx.parallel('playerok/new-deal', event);
    await ctx.parallel('playerok/new-deal', event);

    const summary = analytics.getSummary({ period: 'all', now: NOW });
    expect(summary.orders).toBe(1);
    expect(summary.revenue).toBe(150);
    expect(analytics.getTopItems(5, 'all', NOW)).toEqual([
      { id: 'item-1', name: 'Товар', qty: 1, revenue: 150 },
    ]);
    expect(readStore(ctx).seenDeals).toEqual([orderMarker('deal-1')]);
  });

  it('counts a SENT status as completed exactly once per deal', async () => {
    const { ctx, analytics } = await bootAnalytics();
    const deal = makeDeal('deal-1', { status: ItemDealStatuses.SENT });

    await ctx.parallel('playerok/new-deal', makeDealEvent(makeDeal('deal-1')));
    await ctx.parallel(
      'playerok/deal-status-changed',
      makeDealEvent(deal, EventTypes.DEAL_STATUS_CHANGED),
    );
    await ctx.parallel(
      'playerok/deal-status-changed',
      makeDealEvent(deal, EventTypes.DEAL_STATUS_CHANGED),
    );
    // Another transport event carrying the same transition is also a no-op.
    await ctx.parallel('playerok/deal-confirmed', makeDealEvent(deal, EventTypes.DEAL_CONFIRMED));

    const summary = analytics.getSummary({ period: 'all', now: NOW });
    expect(summary.completed).toBe(1);
    expect(summary.cancelled).toBe(0);
    expect(readStore(ctx).seenDeals).toContain(statusMarker('completed', 'deal-1'));
  });

  it('counts ROLLED_BACK as cancelled exactly once per deal', async () => {
    const { ctx, analytics } = await bootAnalytics();
    const deal = makeDeal('deal-2', {
      price: 70,
      status: ItemDealStatuses.ROLLED_BACK,
      createdAt: daysAgo(1),
    });

    await ctx.parallel(
      'playerok/new-deal',
      makeDealEvent(makeDeal('deal-2', { price: 70, createdAt: daysAgo(1) })),
    );
    await ctx.parallel(
      'playerok/deal-status-changed',
      makeDealEvent(deal, EventTypes.DEAL_STATUS_CHANGED),
    );
    await ctx.parallel(
      'playerok/deal-rolled-back',
      makeDealEvent(deal, EventTypes.DEAL_ROLLED_BACK),
    );

    const summary = analytics.getSummary({ period: 'all', now: NOW });
    expect(summary.cancelled).toBe(1);
    expect(summary.completed).toBe(0);
    // The cancelled counter lands on the sale day, not on the status-change day.
    expect(analytics.getDailySeries(3, NOW)[1]).toEqual({
      date: '2026-03-14',
      revenue: 70,
      orders: 1,
      net: 70,
    });
    expect(readStore(ctx).days['2026-03-14']?.cancelled).toBe(1);
  });

  it('backfills cached orders idempotently (including their status)', async () => {
    const { ctx, analytics } = await bootAnalytics();
    const cached: CachedOrders = {
      'order-1': {
        id: 'order-1',
        price: 200,
        status: ItemDealStatuses.CONFIRMED,
        date: daysAgo(1),
        item_id: 'item-a',
        item_name: 'A',
      },
      'order-2': {
        id: 'order-2',
        price: 300,
        status: ItemDealStatuses.PENDING,
        date: daysAgo(2),
        item_id: 'item-b',
        item_name: 'B',
      },
    };
    ctx.storage.set('cached_orders', cached);

    expect(await analytics.backfill(NOW)).toEqual({ added: 2 });
    const first = analytics.getSummary({ period: 'all', now: NOW });
    expect(first).toEqual({
      gross: 500,
      fees: 0,
      withdrawn: 0,
      net: 500,
      revenue: 500,
      orders: 2,
      completed: 1,
      cancelled: 0,
      avgOrder: 250,
    });

    // Second call: markers make it a no-op, every number stays identical.
    expect(await analytics.backfill(NOW)).toEqual({ added: 0 });
    expect(analytics.getSummary({ period: 'all', now: NOW })).toEqual(first);
    expect(analytics.getTopItems(5, 'all', NOW)).toEqual([
      { id: 'item-b', name: 'B', qty: 1, revenue: 300 },
      { id: 'item-a', name: 'A', qty: 1, revenue: 200 },
    ]);
  });

  it('runs an idempotent startup backfill unless it is disabled', async () => {
    const dir = makeTempDir();
    const first = await makeContext(dir);
    first.storage.set('cached_orders', {
      'order-1': {
        id: 'order-1',
        price: 120,
        status: ItemDealStatuses.SENT,
        date: NOW.toISOString(),
        item_id: 'item-a',
        item_name: 'A',
      },
    });
    await first.use(AnalyticsService);
    expect(first.analytics.getSummary({ period: 'all', now: NOW })).toEqual({
      gross: 120,
      fees: 0,
      withdrawn: 0,
      net: 120,
      revenue: 120,
      orders: 1,
      completed: 1,
      cancelled: 0,
      avgOrder: 120,
    });

    // bot/init is the second pass over the same cache: nothing to add.
    await first.parallel('bot/init');
    expect(first.analytics.getSummary({ period: 'all', now: NOW }).orders).toBe(1);

    // A fresh process over the same data directory must not count it again either.
    const second = await makeContext(dir);
    await second.use(AnalyticsService);
    expect(second.analytics.getSummary({ period: 'all', now: NOW }).revenue).toBe(120);
  });

  it('does not double count a deal seen through both NEW_DEAL and the cached-orders backfill', async () => {
    const { ctx, analytics } = await bootAnalytics();
    await ctx.parallel('playerok/new-deal', makeDealEvent(makeDeal('deal-1', { price: 100 })));

    ctx.storage.set('cached_orders', {
      'deal-1': {
        id: 'deal-1',
        price: 100,
        status: ItemDealStatuses.SENT,
        date: NOW.toISOString(),
        item_id: 'item-1',
        item_name: 'Товар',
      },
    });
    expect(await analytics.backfill(NOW)).toEqual({ added: 0 });

    const summary = analytics.getSummary({ period: 'all', now: NOW });
    expect(summary.orders).toBe(1);
    expect(summary.revenue).toBe(100);
    expect(summary.completed).toBe(1);
  });

  it('windows day/week/month/all by UTC calendar day', async () => {
    const { ctx, analytics } = await bootAnalytics();
    const deals = [
      makeDeal('d-today', { price: 100, createdAt: NOW.toISOString() }),
      makeDeal('d-3', { price: 200, createdAt: daysAgo(3) }),
      makeDeal('d-10', { price: 400, createdAt: daysAgo(10) }),
      makeDeal('d-40', { price: 800, createdAt: daysAgo(40) }),
    ];
    for (const deal of deals) {
      await ctx.parallel('playerok/new-deal', makeDealEvent(deal));
    }

    const summary = (period: 'day' | 'week' | 'month' | 'all') =>
      analytics.getSummary({ period, now: NOW });

    expect(summary('day')).toEqual({
      gross: 100,
      fees: 0,
      withdrawn: 0,
      net: 100,
      revenue: 100,
      orders: 1,
      completed: 0,
      cancelled: 0,
      avgOrder: 100,
    });
    expect(summary('week')).toEqual({
      gross: 300,
      fees: 0,
      withdrawn: 0,
      net: 300,
      revenue: 300,
      orders: 2,
      completed: 0,
      cancelled: 0,
      avgOrder: 150,
    });
    const month = summary('month');
    expect(month.revenue).toBe(700);
    expect(month.orders).toBe(3);
    expect(month.avgOrder).toBeCloseTo(700 / 3, 10);
    expect(summary('all')).toEqual({
      gross: 1500,
      fees: 0,
      withdrawn: 0,
      net: 1500,
      revenue: 1500,
      orders: 4,
      completed: 0,
      cancelled: 0,
      avgOrder: 375,
    });
  });

  it('orders top items by revenue and keeps the last known name', async () => {
    const { ctx, analytics } = await bootAnalytics();
    await ctx.parallel(
      'playerok/new-deal',
      makeDealEvent(
        makeDeal('d-1', { price: 100, itemId: 'item-a', itemName: 'Старое имя' }),
      ),
    );
    await ctx.parallel(
      'playerok/new-deal',
      makeDealEvent(
        makeDeal('d-2', { price: 200, itemId: 'item-a', itemName: 'Новое имя' }),
      ),
    );
    await ctx.parallel(
      'playerok/new-deal',
      makeDealEvent(makeDeal('d-3', { price: 500, itemId: 'item-b', itemName: 'B' })),
    );

    expect(analytics.getTopItems(5, 'all', NOW)).toEqual([
      { id: 'item-b', name: 'B', qty: 1, revenue: 500 },
      { id: 'item-a', name: 'Новое имя', qty: 2, revenue: 300 },
    ]);
    expect(analytics.getTopItems(1, 'all', NOW)).toEqual([
      { id: 'item-b', name: 'B', qty: 1, revenue: 500 },
    ]);
    expect(analytics.getTopItems(0, 'all', NOW)).toEqual([]);
  });

  it('prunes day buckets older than 400 days and caps seenDeals at 5000 in the same mutation', async () => {
    const { ctx, analytics } = await bootAnalytics();
    const oldKey = analyticsDayKey(
      new Date(NOW.getTime() - (ANALYTICS_RETENTION_DAYS + 1) * DAY_MS),
    );
    const keptKey = analyticsDayKey(
      new Date(NOW.getTime() - (ANALYTICS_RETENTION_DAYS - 1) * DAY_MS),
    );
    const seededStore: AnalyticsStore = {
      days: {
        [oldKey]: { revenue: 5, orders: 1, completed: 0, cancelled: 0, fees: 0, withdrawn: 0, items: {} },
        [keptKey]: { revenue: 7, orders: 2, completed: 0, cancelled: 0, fees: 0, withdrawn: 0, items: {} },
      },
      seenDeals: Array.from(
        { length: ANALYTICS_MAX_SEEN_DEALS + 3 },
        (_, index) => `order:seed-${index}`,
      ),
      updatedAt: NOW.toISOString(),
    };
    ctx.storage.set('analytics', seededStore);

    // The mutation runs with NOW so the 400-day retention cutoff is calendar-deterministic.
    await analytics.recordNewDeal(makeDeal('fresh', { price: 50 }), NOW);

    const after = readStore(ctx);
    expect(after.days[oldKey]).toBeUndefined();
    expect(after.days[keptKey]?.revenue).toBe(7);
    expect(after.days['2026-03-15']?.revenue).toBe(50);
    expect(after.seenDeals).toHaveLength(ANALYTICS_MAX_SEEN_DEALS);
    expect(after.seenDeals).not.toContain('order:seed-0');
    expect(after.seenDeals).toContain('order:seed-4');
    expect(after.seenDeals).toContain('order:seed-5002');
    expect(after.seenDeals).toContain(orderMarker('fresh'));
  });
});
