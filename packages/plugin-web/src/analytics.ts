import type { CachedOrder } from '@pkh/core';

/**
 * Pure revenue aggregation for the read-only dashboard.
 *
 * Everything here is computed from the existing `cached_orders` storage store:
 * the dashboard must not grow a second source of truth. Dates come from
 * PlayerOK as ISO strings, so a record whose date cannot be parsed still counts
 * towards all-time totals but never towards a calendar window.
 */

/** One revenue window on the analytics page. */
export interface AnalyticsTotals {
  /** Sum of order prices inside the window, rounded to kopecks. */
  revenue: number;
  /** Number of orders inside the window. */
  orders: number;
  /** `revenue / orders`, or null when the window is empty (rendered as "нет данных"). */
  averageOrderValue: number | null;
}

export interface AnalyticsItemView {
  itemId: string;
  itemName: string;
  revenue: number;
  orders: number;
}

export interface AnalyticsView {
  /** ISO timestamp the snapshot was taken at. */
  generatedAt: string;
  /** Number of records the numbers were computed from. */
  cachedOrders: number;
  /** Since local midnight. */
  today: AnalyticsTotals;
  /** Since local midnight six days ago (seven calendar days including today). */
  last7Days: AnalyticsTotals;
  /** Since local midnight twenty-nine days ago (thirty calendar days including today). */
  last30Days: AnalyticsTotals;
  allTime: AnalyticsTotals;
  /** Up to {@link ANALYTICS_TOP_ITEMS} items, highest revenue first. */
  topItems: AnalyticsItemView[];
}

/** How many rows the "top items by revenue" list shows. */
export const ANALYTICS_TOP_ITEMS = 5;

/** Local midnight of the day `now` falls on, in epoch milliseconds. */
export function startOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Local midnight `daysBack` calendar days before the day `now` falls on.
 * Uses date arithmetic (not a fixed millisecond offset) so a DST change cannot
 * shift the window boundary by an hour.
 */
export function startOfLocalDayOffset(now: number, daysBack: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysBack);
  return date.getTime();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function totalsOf(revenue: number, orders: number): AnalyticsTotals {
  return {
    revenue: round2(revenue),
    orders,
    averageOrderValue: orders === 0 ? null : round2(revenue / orders),
  };
}

/**
 * Aggregate cached orders into the analytics payload.
 *
 * @param orders every record of the `cached_orders` store
 * @param now    injection point for tests; defaults to the current time
 */
export function computeAnalytics(
  orders: Iterable<CachedOrder>,
  now: number = Date.now(),
): AnalyticsView {
  const cutToday = startOfLocalDay(now);
  const cut7 = startOfLocalDayOffset(now, 6);
  const cut30 = startOfLocalDayOffset(now, 29);

  let revenueToday = 0;
  let revenue7 = 0;
  let revenue30 = 0;
  let revenueAll = 0;
  let ordersToday = 0;
  let orders7 = 0;
  let orders30 = 0;
  let ordersAll = 0;
  let cachedOrders = 0;

  const items = new Map<string, AnalyticsItemView>();

  for (const order of orders) {
    cachedOrders += 1;
    // A non-finite price would poison every sum, so it degrades to zero instead.
    const price = Number.isFinite(order.price) ? order.price : 0;

    revenueAll += price;
    ordersAll += 1;

    const at = Date.parse(order.date);
    if (Number.isFinite(at)) {
      if (at >= cut30) {
        revenue30 += price;
        orders30 += 1;
      }
      if (at >= cut7) {
        revenue7 += price;
        orders7 += 1;
      }
      if (at >= cutToday) {
        revenueToday += price;
        ordersToday += 1;
      }
    }

    const itemId = order.item_id;
    const existing = items.get(itemId);
    if (existing) {
      existing.revenue += price;
      existing.orders += 1;
    } else {
      items.set(itemId, {
        itemId,
        itemName: order.item_name,
        revenue: price,
        orders: 1,
      });
    }
  }

  const topItems = [...items.values()]
    .sort(
      (left, right) =>
        right.revenue - left.revenue ||
        right.orders - left.orders ||
        left.itemId.localeCompare(right.itemId),
    )
    .slice(0, ANALYTICS_TOP_ITEMS)
    .map((item) => ({ ...item, revenue: round2(item.revenue) }));

  return {
    generatedAt: new Date(now).toISOString(),
    cachedOrders,
    today: totalsOf(revenueToday, ordersToday),
    last7Days: totalsOf(revenue7, orders7),
    last30Days: totalsOf(revenue30, orders30),
    allTime: totalsOf(revenueAll, ordersAll),
    topItems,
  };
}
