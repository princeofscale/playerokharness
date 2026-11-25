import {
  bindingKey,
  itemMatchesBinding,
  safeInterval,
  Service,
  type AutoDeliveryReservation,
  type AutoDeliveryRule,
  type ChatMessage,
  type Context,
  type DealEvent,
} from '@pkh/core';
import '@pkh/adapter';
import '@pkh/plugin-retry-queue';
import type { RetryTask } from '@pkh/plugin-retry-queue';

/** Storage key of the rule list; the critical section is scoped to this store only. */
export const AUTO_DELIVERY_STORE = 'auto_deliveries';

/** How often the stale-reservation sweep runs (nobody may hold a buyer's key forever). */
export const DEFAULT_RESERVATION_SWEEP_MS = 10 * 60 * 1000;

/**
 * How long a reservation may survive without a settle before the sweep returns the key
 * to the sellable pool. Long enough to outlive a retry-queue backlog, short enough that
 * a crash cannot hide inventory for a day.
 */
export const DEFAULT_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface AutoDeliveryConfig {
  enableTimer?: boolean;
  /** Reservation lifetime before the sweep returns the key to the sellable pool. */
  reservationTtlMs?: number;
  /** Interval of the stale-reservation sweep. */
  sweepIntervalMs?: number;
}

/** Result of moving one key from `goods` to `reserved` for a deal. */
type ReserveOutcome =
  | { kind: 'reserved'; good: string }
  | { kind: 'empty' }
  | { kind: 'already' }
  | { kind: 'missing' };

/**
 * Finds the rule a reservation belongs to. The index is only trusted while its
 * binding key still matches: between the read of the rule list and the settle there
 * is a network await, during which the panel can add, remove or reorder rules. Two
 * rules with identical bindings share a key, so the index is the tie-breaker.
 */
function locateRule(list: AutoDeliveryRule[], index: number, key: string): AutoDeliveryRule | undefined {
  const atIndex = list[index];
  if (atIndex && bindingKey(atIndex) === key) return atIndex;
  return list.find((entry) => bindingKey(entry) === key);
}

/**
 * Piece-by-piece auto-delivery with a reservation step.
 *
 * The old flow read the rule list, sent the key and only then spliced it out of
 * `goods`, all under a store-wide `runExclusive` held across the network await: the
 * key stayed sellable for the whole duration of the send, so two deals could hand the
 * same key to two buyers, and every deal waited for every other deal's network call.
 *
 * Now: reserve (sync, locked) -> send (no lock) -> settle (sync, locked). A key only
 * ever exists in exactly one of `goods` (sellable) or `reserved` (owned by a deal).
 */
export class AutoDeliveryService extends Service {
  static provide = 'autoDelivery';
  static inject = ['storage', 'blacklist', 'playerok'];

  private readonly log;
  private readonly reservationTtlMs: number;

  /**
   * Deals whose delivery pass is running right now. The persistent idempotency marker
   * and the reservation itself only protect after/before the pass; this closes the
   * window in which the very same NEW_DEAL arrives twice concurrently (WS reconnect
   * replay overlapping a live event) and both passes reserve a key for one deal.
   */
  private readonly inFlightDeals = new Set<string>();

  constructor(ctx: Context, config: AutoDeliveryConfig = {}) {
    super(ctx, 'autoDelivery');
    this.log = ctx.logger('automation.delivery');
    this.reservationTtlMs = config.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;

    ctx.on('playerok/new-deal', async (event) => {
      try {
        await this.handleNewDeal(event);
      } catch (err) {
        this.log.error(
          `Ошибка авто-выдачи по сделке ${event.deal.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    // A key reserved for a queued retry used to stay unavailable until the 24h TTL
    // sweep even after the retry delivered it. Settle it the moment the task succeeds.
    ctx.on('retry/succeeded', async (task) => {
      await this.settleQueuedDelivery(task).catch((err) => {
        this.log.error(
          `Не удалось закрыть резерв после успешного ретрая #${task.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    if (config.enableTimer !== false) {
      safeInterval(
        ctx,
        async () => {
          await this.releaseStaleReservations();
        },
        config.sweepIntervalMs ?? DEFAULT_RESERVATION_SWEEP_MS,
        'autoDelivery:reservations',
      );
      // Ключи, зарезервированные процессом, который упал до отправки, иначе висят вечно.
      void this.releaseStaleReservations().catch((err) => {
        this.log.error(
          `Не удалось снять просроченные резервы при старте: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  private async handleNewDeal(event: DealEvent): Promise<void> {
    if (event.deal.user.id === this.ctx.playerok.account?.id) return;
    if (this.ctx.blacklist.isBlacklisted(this.ctx.playerok.getDealUsername(event))) return;

    if (this.ctx.storage.isDealDelivered(event.deal.id)) {
      this.log.debug(`Сделка ${event.deal.id} уже была выдана ранее — пропуск дубликата`);
      return;
    }
    if (this.inFlightDeals.has(event.deal.id)) {
      this.log.debug(`Сделка ${event.deal.id} уже обрабатывается — пропуск дубликата события`);
      return;
    }

    this.inFlightDeals.add(event.deal.id);
    try {
      await this.deliverDeal(event);
    } finally {
      this.inFlightDeals.delete(event.deal.id);
    }
  }

  /**
   * Finds the reservation created for a queued `send_message` and settles it: the key is
   * gone for good, the deal is marked delivered. No-op for every other task kind.
   */
  private async settleQueuedDelivery(task: RetryTask): Promise<void> {
    if (task.kind !== 'send_message') return;
    const prefix = 'delivery:';
    if (!task.dedupeKey?.startsWith(prefix)) return;
    const dealId = task.dedupeKey.slice(prefix.length).split(':')[0];
    const good = typeof task.payload?.text === 'string' ? task.payload.text : undefined;
    if (!dealId || !good) return;

    const settled = await this.ctx.storage.runExclusive('auto_deliveries', () => {
      let removed = false;
      this.ctx.storage.update<AutoDeliveryRule[]>('auto_deliveries', (list) => {
        for (const rule of list) {
          if (!rule.reserved?.length) continue;
          const index = rule.reserved.findIndex(
            (entry) => entry.dealId === dealId && entry.good === good,
          );
          if (index === -1) continue;
          rule.reserved.splice(index, 1);
          removed = true;
          break;
        }
      });
      return removed;
    });

    if (settled) {
      this.ctx.storage.markDealDelivered(dealId);
      this.log.info(`Повторная выдача по сделке ${dealId} доставлена — резерв снят`);
    }
  }

  private async deliverDeal(event: DealEvent): Promise<void> {
    const rules = this.ctx.storage.getAutoDeliveries();
    const retryQueue = this.ctx.get('retryQueue', false);
    let anyDelivered = false;

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!itemMatchesBinding(event.deal.item, rule)) continue;
      const key = bindingKey(rule);

      if (rule.piece) {
        // --- critical section 1: take a key out of the sellable pool (sync) ---
        const outcome = await this.runExclusive(() => this.reserve(i, key, event.deal.id));

        if (outcome.kind === 'empty') {
          this.log.warn(`Авто-выдача по товару «${event.deal.item.name}»: закончились поштучные товары!`);
          continue;
        }
        if (outcome.kind === 'already') {
          this.log.debug(
            `Сделка ${event.deal.id}: товар для правила «${event.deal.item.name}» уже зарезервирован — пропуск`,
          );
          continue;
        }
        if (outcome.kind === 'missing') {
          this.log.warn(
            `Сделка ${event.deal.id}: правило авто-выдачи изменилось до выдачи товара «${event.deal.item.name}» — пропуск`,
          );
          continue;
        }

        const good = outcome.good;
        // --- no lock: the network call of one deal must not block any other deal ---
        let sent: ChatMessage | null = null;
        let sendError: string | undefined;
        try {
          sent = await this.ctx.playerok.sendMessage(event.chat.id, good);
        } catch (err) {
          sendError = err instanceof Error ? err.message : String(err);
        }

        if (sent) {
          anyDelivered = true;
          const remaining = await this.runExclusive(() => this.settleDelivered(i, key, good, event.deal.id));
          if (remaining === null) {
            this.log.warn(
              `Товар «${good}» выдан, но резерв не найден в правиле авто-выдачи — проверьте остатки вручную`,
            );
          } else {
            this.log.info(
              `Покупателю ${event.deal.user.username} выдан товар «${good}». Остаток: ${remaining}`,
            );
          }
        } else if (retryQueue) {
          // The key stays reserved: the retry task owns it, and it must not be sold to
          // another buyer while the send is pending.
          try {
            await retryQueue.enqueue({
              kind: 'send_message',
              payload: { chatId: event.chat.id, text: good },
              dedupeKey: `delivery:${event.deal.id}:${i}`,
              error: sendError ?? 'sendMessage failed during auto-delivery',
            });
            anyDelivered = true;
            this.log.warn(
              `Товар «${good}» не отправлен (${sendError ?? 'sendMessage вернул null'}) — поставлен в очередь повторов и остаётся зарезервированным`,
            );
          } catch (enqueueErr) {
            // Neither sent nor retryable: return the key to the pool, otherwise it is
            // neither sent nor sellable (silent inventory loss).
            await this.runExclusive(() => this.releasePiece(i, key, good, event.deal.id));
            this.log.error(
              `Не удалось поставить выдачу в очередь повторов: ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)} — товар возвращён в остатки`,
            );
          }
        } else {
          await this.runExclusive(() => this.releasePiece(i, key, good, event.deal.id));
          this.log.error(
            `Товар «${good}» не отправлен (${sendError ?? 'sendMessage вернул null'}), очередь повторов недоступна — товар возвращён в остатки`,
          );
        }
      } else {
        const lines = rule.message ?? [];
        if (lines.length === 0) continue;
        const text = lines.join('\n');
        let sent: ChatMessage | null = null;
        let sendError: string | undefined;
        try {
          sent = await this.ctx.playerok.sendMessage(event.chat.id, text);
        } catch (err) {
          sendError = err instanceof Error ? err.message : String(err);
        }

        if (sent) {
          anyDelivered = true;
          this.log.info(`Покупателю ${event.deal.user.username} отправлено сообщение авто-выдачи`);
        } else if (retryQueue) {
          try {
            await retryQueue.enqueue({
              kind: 'send_message',
              payload: { chatId: event.chat.id, text },
              dedupeKey: `delivery:${event.deal.id}:${i}`,
              error: sendError ?? 'sendMessage failed during auto-delivery',
            });
            anyDelivered = true;
          } catch (enqueueErr) {
            this.log.error(
              `Не удалось поставить сообщение авто-выдачи в очередь повторов: ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}`,
            );
          }
        }
      }
    }

    if (anyDelivered) this.ctx.storage.markDealDelivered(event.deal.id);
  }

  /**
   * Moves one key from `goods` to `reserved` for this deal. Synchronous by design: it
   * runs inside the store lock and must not await anything, so no other event can
   * observe the key as available between the read and the write.
   */
  private reserve(index: number, key: string, dealId: string): ReserveOutcome {
    let outcome: ReserveOutcome = { kind: 'missing' };
    const at = new Date().toISOString();

    this.ctx.storage.update<AutoDeliveryRule[]>(AUTO_DELIVERY_STORE, (list) => {
      const rule = locateRule(list, index, key);
      if (!rule) return;

      const reserved = rule.reserved ?? [];
      if (reserved.some((entry) => entry.dealId === dealId)) {
        outcome = { kind: 'already' };
        return;
      }

      const goods = rule.goods ?? [];
      const held = new Set(reserved.map((entry) => entry.good));
      const goodsIndex = goods.findIndex((candidate) => !held.has(candidate));
      if (goodsIndex === -1) {
        outcome = { kind: 'empty' };
        return;
      }

      const [good] = goods.splice(goodsIndex, 1);
      reserved.push({ good, dealId, at });
      rule.goods = goods;
      rule.reserved = reserved;
      outcome = { kind: 'reserved', good };
    });

    return outcome;
  }

  /**
   * Removes the reservation after a successful send and marks the deal delivered in the
   * same synchronous critical section, so a replayed NEW_DEAL cannot reserve a second
   * key in the gap between "sent" and "recorded".
   */
  private settleDelivered(index: number, key: string, good: string, dealId: string): number | null {
    let remaining: number | null = null;

    this.ctx.storage.update<AutoDeliveryRule[]>(AUTO_DELIVERY_STORE, (list) => {
      const rule = locateRule(list, index, key);
      if (!rule) return;
      const reserved = rule.reserved ?? [];
      const reservedIndex = reserved.findIndex((entry) => entry.good === good && entry.dealId === dealId);
      if (reservedIndex === -1) return;
      reserved.splice(reservedIndex, 1);
      if (reserved.length === 0) delete rule.reserved;
      else rule.reserved = reserved;
      remaining = rule.goods?.length ?? 0;
    });

    this.ctx.storage.markDealDelivered(dealId);
    return remaining;
  }

  /** Returns a key the send failed on (and no retry took ownership of) to `goods`. */
  private releasePiece(index: number, key: string, good: string, dealId: string): void {
    this.ctx.storage.update<AutoDeliveryRule[]>(AUTO_DELIVERY_STORE, (list) => {
      const rule = locateRule(list, index, key);
      if (!rule) return;

      const reserved = rule.reserved ?? [];
      const reservedIndex = reserved.findIndex((entry) => entry.good === good && entry.dealId === dealId);
      if (reservedIndex !== -1) {
        reserved.splice(reservedIndex, 1);
        if (reserved.length === 0) delete rule.reserved;
        else rule.reserved = reserved;
      } else {
        this.log.warn(`Резерв товара «${good}» не найден — ключ всё равно возвращён в остатки`);
      }

      const goods = rule.goods ?? [];
      if (!goods.includes(good)) goods.push(good);
      rule.goods = goods;
    });
  }

  /**
   * Returns keys whose reservation is older than the TTL to `goods`: a crash between
   * reserve and settle must not lock a buyer's key out of the shop forever.
   *
   * A key that a live retry task still owns (pending/processing) is kept reserved even
   * past the TTL — releasing it would sell a key the queue is about to deliver. Dead
   * (dead-letter) tasks are ignored, which is exactly the "operator must look at it"
   * case the TTL exists for.
   */
  public async releaseStaleReservations(
    now: Date = new Date(),
    ttlMs: number = this.reservationTtlMs,
  ): Promise<number> {
    const nowMs = now.getTime();
    return this.runExclusive(() => {
      const list = this.ctx.storage.get<AutoDeliveryRule[]>(AUTO_DELIVERY_STORE);
      const queued = this.liveQueuedGoods();
      let released = 0;
      let changed = false;

      for (const rule of list) {
        const reserved = rule.reserved;
        if (!reserved || reserved.length === 0) continue;

        const keep: AutoDeliveryReservation[] = [];
        const back: string[] = [];
        for (const entry of reserved) {
          const at = Date.parse(entry.at);
          const expired = Number.isNaN(at) || nowMs - at >= ttlMs;
          if (expired && !queued.has(entry.good)) back.push(entry.good);
          else keep.push(entry);
        }
        if (back.length === 0) continue;

        rule.goods = [...(rule.goods ?? []), ...back];
        if (keep.length > 0) rule.reserved = keep;
        else delete rule.reserved;
        released += back.length;
        changed = true;
      }

      if (changed) this.ctx.storage.set(AUTO_DELIVERY_STORE, list);
      return released;
    });
  }

  /** Goods a live (non-dead) retry task still owns; empty when no queue is mounted. */
  private liveQueuedGoods(): Set<string> {
    const queue = this.ctx.get('retryQueue', false);
    if (!queue) return new Set();

    const queued = new Set<string>();
    try {
      for (const task of queue.list()) {
        if (task.status === 'dead') continue;
        if (task.kind !== 'send_message') continue;
        const text = task.payload?.text;
        if (typeof text === 'string') queued.add(text);
      }
    } catch (err) {
      this.log.warn(
        `Не удалось проверить очередь повторов при снятии резервов: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return queued;
  }

  private runExclusive<T>(task: () => T): Promise<T> {
    return this.ctx.storage.runExclusive(AUTO_DELIVERY_STORE, task);
  }
}

declare module 'cordis' {
  interface Context {
    autoDelivery: AutoDeliveryService;
  }
}

/**
 * @deprecated Legacy plugin shape. Mounting this wrapper provides `autoDelivery` inside a
 * nested context (invisible to the parent), so `mountAutomation()` uses the service
 * directly. Kept so existing imports keep working.
 */
export const autoDeliveryPlugin = {
  name: 'automation:auto-delivery',
  inject: ['storage', 'blacklist', 'playerok'],
  apply(ctx: Context, config: AutoDeliveryConfig = {}): void {
    ctx.use(AutoDeliveryService, config);
  },
};
