import {
  Context,
  ItemDealStatuses,
  Service,
  TransactionOperations,
  TransactionStatuses,
  z,
  type CachedOrders,
  type ItemDeal,
  type Transaction,
} from '@pkh/core';
import '@pkh/adapter';

/** Storage key and file backing the analytics store: `bot_data/analytics.json`. */
export const ANALYTICS_STORE_KEY = 'analytics';
/** Day buckets older than this many days are pruned on every mutation. */
export const ANALYTICS_RETENTION_DAYS = 400;
/**
 * Upper bound on the idempotency marker list (oldest markers are dropped first).
 * Order, status, fee and withdrawal markers share this one list.
 */
export const ANALYTICS_MAX_SEEN_DEALS = 5000;

const DAY_MS = 86_400_000;

export const AnalyticsItemSchema = z.object({
  name: z.string().default(''),
  qty: z.number().int().nonnegative().default(0),
  revenue: z.number().default(0),
});

export const AnalyticsDaySchema = z.object({
  revenue: z.number().default(0),
  orders: z.number().int().nonnegative().default(0),
  completed: z.number().int().nonnegative().default(0),
  cancelled: z.number().int().nonnegative().default(0),
  /** Commission/fee amounts paid on transactions bucketed into this day. */
  fees: z.number().nonnegative().default(0),
  /** Money moved out of the balance (withdrawals) bucketed into this day. */
  withdrawn: z.number().nonnegative().default(0),
  items: z.record(z.string(), AnalyticsItemSchema).default({}),
});

export const AnalyticsStoreSchema = z.object({
  days: z.record(z.string(), AnalyticsDaySchema).default({}),
  seenDeals: z.array(z.string()).default([]),
  updatedAt: z.string().default(''),
});

export type AnalyticsItem = z.infer<typeof AnalyticsItemSchema>;
export type AnalyticsDay = z.infer<typeof AnalyticsDaySchema>;
export type AnalyticsStore = z.infer<typeof AnalyticsStoreSchema>;

export type AnalyticsPeriod = 'day' | 'week' | 'month' | 'all';
export type AnalyticsStatusKind = 'completed' | 'cancelled';

export interface AnalyticsStatsOptions {
  period: AnalyticsPeriod;
  /** Injected clock; defaults to `new Date()`. */
  now?: Date;
}

export interface AnalyticsSummary {
  /** Gross sale revenue before fees and withdrawals; same number as `revenue`. */
  gross: number;
  /** Commission/fee amounts accumulated from transactions in the window. */
  fees: number;
  /** Money moved out of the balance (withdrawals) in the window. */
  withdrawn: number;
  /** `gross - fees - withdrawn`. */
  net: number;
  /** Legacy alias of {@link gross}; kept for existing dashboard/panel consumers. */
  revenue: number;
  orders: number;
  completed: number;
  cancelled: number;
  avgOrder: number;
}

export interface AnalyticsTopItem {
  id: string;
  name: string;
  qty: number;
  revenue: number;
}

export interface AnalyticsSeriesPoint {
  date: string;
  revenue: number;
  orders: number;
  /** `revenue - fees - withdrawn` for that day. */
  net: number;
}

export interface AnalyticsBackfillResult {
  /** Orders added by this call; a second call over the same cache returns 0. */
  added: number;
}

export interface AnalyticsConfig {
  /**
   * Run a cached-orders backfill on startup (also always available through
   * `backfill()` and on `bot/init`). Defaults to true; tests disable it.
   */
  enableBackfill?: boolean;
}

/** Calendar spans for the rolling windows used by the summary views. */
export const ANALYTICS_PERIOD_SPAN_DAYS: Record<Exclude<AnalyticsPeriod, 'all'>, number> = {
  day: 1,
  week: 7,
  month: 30,
};

const COMPLETED_STATUSES: ReadonlySet<string> = new Set<string>([
  ItemDealStatuses.SENT,
  ItemDealStatuses.CONFIRMED,
  ItemDealStatuses.CONFIRMED_AUTOMATICALLY,
  'COMPLETED',
]);

const CANCELLED_STATUSES: ReadonlySet<string> = new Set<string>([
  ItemDealStatuses.ROLLED_BACK,
  'CANCELLED',
]);

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** UTC `YYYY-MM-DD` bucket key for a point in time. */
export function analyticsDayKey(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * Day keys covered by a period, oldest first, ending on `now`'s UTC day.
 * `all` returns null because it is not a window over the calendar.
 */
export function analyticsWindowKeys(period: AnalyticsPeriod, now: Date): string[] | null {
  if (period === 'all') return null;
  const span = ANALYTICS_PERIOD_SPAN_DAYS[period];
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const keys: string[] = [];
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    keys.push(analyticsDayKey(new Date(todayStart - offset * DAY_MS)));
  }
  return keys;
}

/** Idempotency marker for "this deal was counted as an order". */
export function orderMarker(dealId: string): string {
  return `order:${dealId}`;
}

/** Idempotency marker for "this deal was already counted as completed/cancelled". */
export function statusMarker(kind: AnalyticsStatusKind, dealId: string): string {
  return `${kind}:${dealId}`;
}

/**
 * Idempotency marker for "this transaction's fee/withdrawal was already counted".
 * One namespace covers both the transaction object and the bare withdrawal event:
 * the same transaction replayed through either path is counted exactly once.
 */
export function transactionMarker(transactionId: string): string {
  return `transaction:${transactionId}`;
}

export function statusKind(status: string | null | undefined): AnalyticsStatusKind | null {
  if (!status) return null;
  if (COMPLETED_STATUSES.has(status)) return 'completed';
  if (CANCELLED_STATUSES.has(status)) return 'cancelled';
  return null;
}

function emptyDay(): AnalyticsDay {
  return { revenue: 0, orders: 0, completed: 0, cancelled: 0, fees: 0, withdrawn: 0, items: {} };
}

function ensureDay(store: AnalyticsStore, dayKey: string): AnalyticsDay {
  const existing = store.days[dayKey];
  if (existing) return existing;
  const created = emptyDay();
  store.days[dayKey] = created;
  return created;
}

function markSeen(store: AnalyticsStore, seen: Set<string>, marker: string): void {
  if (seen.has(marker)) return;
  seen.add(marker);
  store.seenDeals.push(marker);
}

function finitePrice(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Non-negative money amount. A missing/garbled fee degrades to 0, and a negative
 * value can never push a day bucket out of its `nonnegative()` schema contract.
 */
function positiveAmount(value: unknown): number {
  const amount = finitePrice(value);
  return amount > 0 ? amount : 0;
}

/**
 * Terminal-failure statuses: a rolled-back or failed transaction never moved
 * money, so neither its fee nor its value is counted.
 */
const IGNORED_TRANSACTION_STATUSES: ReadonlySet<string> = new Set<string>([
  TransactionStatuses.ROLLED_BACK,
  TransactionStatuses.FAILED,
]);

/**
 * Bucket for a deal/cached order: its own `createdAt` day when that day is
 * parseable and inside the retention window, otherwise `now`'s day. The clamp
 * matters — a bucket created 400+ days in the past would be pruned by the same
 * mutation and the order would vanish instead of showing up in "all".
 */
function dayKeyFor(createdAt: string | null | undefined, now: Date): string {
  const fallback = analyticsDayKey(now);
  if (!createdAt) return fallback;
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return fallback;
  const key = analyticsDayKey(parsed);
  const cutoffKey = analyticsDayKey(new Date(now.getTime() - ANALYTICS_RETENTION_DAYS * DAY_MS));
  return key < cutoffKey ? fallback : key;
}

interface OrderRecord {
  id: string;
  price: number;
  date?: string | null;
  itemId?: string | null;
  itemName?: string | null;
}

function dealOrderRecord(deal: ItemDeal): OrderRecord {
  const item = deal.item;
  return {
    id: deal.id,
    price: finitePrice(item?.price),
    date: deal.createdAt,
    itemId: item?.id,
    itemName: item?.name,
  };
}

export class AnalyticsService extends Service {
  static provide = 'analytics';
  static inject = ['storage', 'playerok'];

  private readonly log;
  private readonly enableBackfill: boolean;

  constructor(ctx: Context, config: AnalyticsConfig = {}) {
    super(ctx, 'analytics');
    this.log = ctx.logger('analytics');
    this.enableBackfill = config.enableBackfill !== false;

    ctx.storage.registerStore<AnalyticsStore>({
      name: ANALYTICS_STORE_KEY,
      relativePath: 'bot_data/analytics.json',
      schema: AnalyticsStoreSchema,
      defaultValue: () => ({ days: {}, seenDeals: [], updatedAt: '' }),
      restoreMissing: true,
      exportable: true,
    });

    ctx.effect(async () => {
      // Every status-bearing event funnels into the same idempotent recordStatus():
      // a deal is counted at most once per kind no matter which transport event
      // (status change, confirmed, confirmed automatically, rolled back, item sent)
      // delivered the transition.
      const disposers: Array<() => void> = [
        ctx.on('playerok/new-deal', async (event) => {
          await this.runSafely(`новая сделка ${event.deal.id}`, () => this.recordNewDeal(event.deal));
        }),
        ctx.on('playerok/deal-status-changed', async (event) => {
          await this.runSafely(`статус сделки ${event.deal.id}`, () => this.recordStatus(event.deal));
        }),
        ctx.on('playerok/deal-confirmed', async (event) => {
          await this.runSafely(`подтверждение сделки ${event.deal.id}`, () => this.recordStatus(event.deal));
        }),
        ctx.on('playerok/deal-confirmed-automatically', async (event) => {
          await this.runSafely(`автоподтверждение сделки ${event.deal.id}`, () => this.recordStatus(event.deal));
        }),
        ctx.on('playerok/deal-rolled-back', async (event) => {
          await this.runSafely(`откат сделки ${event.deal.id}`, () => this.recordStatus(event.deal));
        }),
        ctx.on('playerok/item-sent', async (event) => {
          await this.runSafely(`выдача сделки ${event.deal.id}`, () => this.recordStatus(event.deal));
        }),
        ctx.on('bot/init', async () => {
          await this.runSafely('бэкфилл по bot/init', () => this.backfill());
          await this.runSafely('бэкфилл транзакций по bot/init', () => this.backfillTransactions());
        }),
        // The one withdrawal signal the core event map actually carries: a
        // WITHDRAW transaction id plus its amount. `playerok/new-transaction`
        // does not exist in @pkh/core, so fee-bearing transactions reach the
        // store through the public recordTransaction() API instead.
        ctx.on('withdrawal/requested', async (info) => {
          await this.runSafely(`списание ${info.transactionId}`, () => this.recordWithdrawal(info));
        }),
      ];

      if (this.enableBackfill) {
        // Startup backfill is idempotent, so running it next to bot/init is safe:
        // whichever comes first fills the gap, the other finds nothing to add.
        // Awaiting it here means ctx.use() resolves with the numbers already filled in.
        await this.runSafely('бэкфилл при старте', () => this.backfill());
        await this.runSafely('бэкфилл транзакций при старте', () => this.backfillTransactions());
      }

      return () => {
        for (const dispose of disposers) dispose();
      };
    });
  }

  private async runSafely(scope: string, task: () => Promise<unknown>): Promise<void> {
    try {
      await task();
    } catch (err) {
      this.log.error(
        `Ошибка аналитики (${scope}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Read-modify-write of the analytics store: one runExclusive per mutation. */
  private async mutate<T>(
    now: Date,
    apply: (store: AnalyticsStore, seen: Set<string>, at: Date) => T,
  ): Promise<T> {
    return this.ctx.storage.runExclusive(ANALYTICS_STORE_KEY, () => {
      const store = this.ctx.storage.get<AnalyticsStore>(ANALYTICS_STORE_KEY);
      const seen = new Set(store.seenDeals);
      const result = apply(store, seen, now);
      store.updatedAt = now.toISOString();
      this.retain(store, now);
      this.ctx.storage.set<AnalyticsStore>(ANALYTICS_STORE_KEY, store);
      return result;
    });
  }

  /** Retention: old day buckets and the oldest idempotency markers. */
  private retain(store: AnalyticsStore, now: Date): void {
    const cutoffKey = analyticsDayKey(new Date(now.getTime() - ANALYTICS_RETENTION_DAYS * DAY_MS));
    for (const key of Object.keys(store.days)) {
      if (key < cutoffKey) delete store.days[key];
    }
    if (store.seenDeals.length > ANALYTICS_MAX_SEEN_DEALS) {
      store.seenDeals = store.seenDeals.slice(-ANALYTICS_MAX_SEEN_DEALS);
    }
  }

  private applyOrder(
    store: AnalyticsStore,
    seen: Set<string>,
    at: Date,
    order: OrderRecord,
  ): boolean {
    if (!order.id) return false;
    const marker = orderMarker(order.id);
    if (seen.has(marker)) return false;

    const bucket = ensureDay(store, dayKeyFor(order.date, at));
    const price = finitePrice(order.price);
    bucket.orders += 1;
    bucket.revenue += price;

    if (order.itemId) {
      const current = bucket.items[order.itemId] ?? { name: '', qty: 0, revenue: 0 };
      current.qty += 1;
      current.revenue += price;
      if (order.itemName) current.name = order.itemName;
      bucket.items[order.itemId] = current;
    }

    markSeen(store, seen, marker);
    return true;
  }

  private applyStatus(
    store: AnalyticsStore,
    seen: Set<string>,
    at: Date,
    dealId: string,
    status: string | null | undefined,
    createdAt?: string | null,
  ): AnalyticsStatusKind | null {
    if (!dealId) return null;
    const kind = statusKind(status);
    if (!kind) return null;
    const marker = statusMarker(kind, dealId);
    if (seen.has(marker)) return null;

    const bucket = ensureDay(store, dayKeyFor(createdAt, at));
    bucket[kind] += 1;
    markSeen(store, seen, marker);
    return kind;
  }

  /**
   * Counts one transaction into the day bucket of its own `createdAt`:
   * its commission into `fees`, and a WITHDRAW's value into `withdrawn`.
   * Rolled-back/failed transactions never moved money and are skipped.
   */
  private applyTransaction(
    store: AnalyticsStore,
    seen: Set<string>,
    at: Date,
    tx: Transaction,
  ): boolean {
    if (!tx?.id) return false;
    const marker = transactionMarker(tx.id);
    if (seen.has(marker)) return false;
    if (IGNORED_TRANSACTION_STATUSES.has(tx.status)) return false;

    const bucket = ensureDay(store, dayKeyFor(tx.createdAt, at));
    let counted = false;

    const fee = positiveAmount(tx.fee);
    if (fee > 0) {
      bucket.fees += fee;
      counted = true;
    }
    if (tx.operation === TransactionOperations.WITHDRAW) {
      const withdrawn = positiveAmount(tx.value);
      if (withdrawn > 0) {
        bucket.withdrawn += withdrawn;
        counted = true;
      }
    }

    markSeen(store, seen, marker);
    return counted;
  }

  /**
   * Counts a bare withdrawal (the `withdrawal/requested` payload): shares the
   * `transaction:` marker namespace with {@link applyTransaction}, so a
   * transaction seen through both paths is still counted exactly once.
   */
  private applyWithdrawal(
    store: AnalyticsStore,
    seen: Set<string>,
    at: Date,
    transactionId: string,
    amount: number,
  ): boolean {
    if (!transactionId) return false;
    const marker = transactionMarker(transactionId);
    if (seen.has(marker)) return false;

    const withdrawn = positiveAmount(amount);
    if (withdrawn <= 0) return false;

    ensureDay(store, dayKeyFor(undefined, at)).withdrawn += withdrawn;
    markSeen(store, seen, marker);
    return true;
  }

  /**
   * Records one NEW_DEAL as an order. Returns false when the deal was already
   * counted (duplicate/new-deal replay) so callers can tell a no-op from a write.
   */
  public async recordNewDeal(deal: ItemDeal, now: Date = new Date()): Promise<boolean> {
    if (!deal?.id) return false;
    return this.mutate(now, (store, seen, at) =>
      this.applyOrder(store, seen, at, dealOrderRecord(deal)),
    );
  }

  /**
   * Counts a status transition as completed/cancelled exactly once per deal.
   * Statuses outside {SENT, CONFIRMED, CONFIRMED_AUTOMATICALLY, COMPLETED,
   * ROLLED_BACK, CANCELLED} are ignored. Returns the kind that was counted.
   */
  public async recordStatus(
    deal: ItemDeal,
    now: Date = new Date(),
  ): Promise<AnalyticsStatusKind | null> {
    if (!deal?.id) return null;
    return this.mutate(now, (store, seen, at) =>
      this.applyStatus(store, seen, at, deal.id, deal.status, deal.createdAt),
    );
  }

  /**
   * Counts one transaction's fee and (for WITHDRAW) its amount exactly once.
   * Returns true only when a number actually changed: a duplicate id, a
   * rolled-back/failed transaction or a transaction with neither a fee nor a
   * withdrawal is a no-op.
   */
  public async recordTransaction(tx: Transaction, now: Date = new Date()): Promise<boolean> {
    if (!tx?.id) return false;
    return this.mutate(now, (store, seen, at) => this.applyTransaction(store, seen, at, tx));
  }

  /**
   * Counts a withdrawal announced through `withdrawal/requested` exactly once
   * per transaction id. Idempotent, so an event replay cannot shrink net profit twice.
   */
  public async recordWithdrawal(
    info: { transactionId: string; amount: number },
    now: Date = new Date(),
  ): Promise<boolean> {
    if (!info?.transactionId) return false;
    return this.mutate(now, (store, seen, at) =>
      this.applyWithdrawal(store, seen, at, info.transactionId, info.amount),
    );
  }

  /**
   * Adds every cached order that is not counted yet (revenue, orders, items and
   * its completed/cancelled status). Idempotent: markers make a second call over
   * the same cache a no-op, so it is safe on startup and on every bot/init.
   */
  /**
   * Fills fees and withdrawals from the transaction history once per start.
   *
   * @pkh/core has no `playerok/new-transaction` event, so without this the net profit
   * of a fresh install stays at gross-0-0 until the first withdrawal happens live.
   * Idempotent: every transaction is marked, so a second call is a no-op.
   */
  public async backfillTransactions(
    count = 100,
    now: Date = new Date(),
  ): Promise<{ counted: number }> {
    let page: { items: Transaction[] };
    try {
      page = await this.ctx.playerok.getTransactions(count);
    } catch (err) {
      this.log.warn(
        `Бэкфилл транзакций недоступен: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { counted: 0 };
    }
    let counted = 0;
    for (const transaction of page.items) {
      if (!transaction?.id) continue;
      if (await this.recordTransaction(transaction, now)) counted += 1;
    }
    if (counted > 0) {
      this.log.info(`Бэкфилл аналитики: учтено транзакций из истории — ${counted}`);
    }
    return { counted };
  }

  public async backfill(now: Date = new Date()): Promise<AnalyticsBackfillResult> {
    let orders: CachedOrders;
    try {
      orders = this.ctx.storage.getCachedOrders();
    } catch (err) {
      this.log.error(
        `Бэкфилл аналитики: кэш заказов недоступен: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { added: 0 };
    }

    const added = await this.mutate(now, (store, seen, at) => {
      let count = 0;
      for (const order of Object.values(orders)) {
        if (!order?.id) continue;
        if (
          this.applyOrder(store, seen, at, {
            id: order.id,
            price: order.price,
            date: order.date,
            itemId: order.item_id,
            itemName: order.item_name,
          })
        ) {
          count += 1;
        }
        this.applyStatus(store, seen, at, order.id, order.status, order.date);
      }
      return count;
    });

    if (added > 0) {
      this.log.info(`Бэкфилл аналитики: добавлено заказов из кэша — ${added}`);
    }
    return { added };
  }

  private readStore(): AnalyticsStore {
    return this.ctx.storage.get<AnalyticsStore>(ANALYTICS_STORE_KEY);
  }

  private selectBuckets(period: AnalyticsPeriod, now: Date): AnalyticsDay[] {
    const store = this.readStore();
    const keys = analyticsWindowKeys(period, now);
    if (keys === null) {
      return Object.keys(store.days)
        .sort()
        .map((key) => store.days[key])
        .filter((bucket): bucket is AnalyticsDay => Boolean(bucket));
    }
    const buckets: AnalyticsDay[] = [];
    for (const key of keys) {
      const bucket = store.days[key];
      if (bucket) buckets.push(bucket);
    }
    return buckets;
  }

  /**
   * Synchronous summary over a calendar-aligned UTC window ending today:
   * `day` = today's bucket, `week` = last 7 day buckets, `month` = last 30,
   * `all` = every retained bucket.
   *
   * `gross` is the sale revenue before costs; `net = gross - fees - withdrawn`.
   * `revenue` is kept as a legacy alias of `gross` so existing consumers of the
   * pre-profit summary keep working unchanged.
   */
  public getSummary(options: AnalyticsStatsOptions): AnalyticsSummary {
    const now = options.now ?? new Date();
    let gross = 0;
    let fees = 0;
    let withdrawn = 0;
    let orders = 0;
    let completed = 0;
    let cancelled = 0;

    for (const bucket of this.selectBuckets(options.period, now)) {
      gross += bucket.revenue;
      fees += bucket.fees;
      withdrawn += bucket.withdrawn;
      orders += bucket.orders;
      completed += bucket.completed;
      cancelled += bucket.cancelled;
    }

    return {
      gross,
      fees,
      withdrawn,
      net: gross - fees - withdrawn,
      revenue: gross,
      orders,
      completed,
      cancelled,
      avgOrder: orders > 0 ? gross / orders : 0,
    };
  }

  /** Items sorted by revenue (desc), then qty (desc), then id — deterministic ties. */
  public getTopItems(
    limit = 5,
    period: AnalyticsPeriod = 'all',
    now: Date = new Date(),
  ): AnalyticsTopItem[] {
    const totals = new Map<string, AnalyticsTopItem>();
    for (const bucket of this.selectBuckets(period, now)) {
      for (const [id, item] of Object.entries(bucket.items)) {
        const current = totals.get(id) ?? { id, name: item.name, qty: 0, revenue: 0 };
        current.qty += item.qty;
        current.revenue += item.revenue;
        if (item.name) current.name = item.name;
        totals.set(id, current);
      }
    }

    const sorted = [...totals.values()].sort(
      (a, b) => b.revenue - a.revenue || b.qty - a.qty || a.id.localeCompare(b.id),
    );
    return limit > 0 ? sorted.slice(0, limit) : [];
  }

  /** Zero-filled daily series, oldest first, ending on `now`'s UTC day. */
  public getDailySeries(days = 30, now: Date = new Date()): AnalyticsSeriesPoint[] {
    const store = this.readStore();
    const span = Math.max(1, Math.floor(days));
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const series: AnalyticsSeriesPoint[] = [];
    for (let offset = span - 1; offset >= 0; offset -= 1) {
      const date = analyticsDayKey(new Date(todayStart - offset * DAY_MS));
      const bucket = store.days[date];
      const gross = bucket?.revenue ?? 0;
      const fees = bucket?.fees ?? 0;
      const withdrawn = bucket?.withdrawn ?? 0;
      series.push({ date, revenue: gross, orders: bucket?.orders ?? 0, net: gross - fees - withdrawn });
    }
    return series;
  }
}

declare module 'cordis' {
  interface Context {
    analytics: AnalyticsService;
  }
}
