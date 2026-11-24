import { ItemDealStatuses, type CachedOrder, type CachedOrders, type Context } from '@pkh/core';
import '@pkh/adapter';

export interface OrdersStatsSummary {
  totalDeals: number;
  confirmedDeals: number;
  refundedDeals: number;
  pendingDeals: number;
  grossAmount: number;
  confirmedAmount: number;
  refundedAmount: number;
}

export type StatsPeriod = 'day' | 'week' | 'month' | 'all';

export function computeOrdersStats(
  orders: CachedOrders,
  period: StatsPeriod,
  now: Date = new Date(),
): OrdersStatsSummary {
  const cutoffMs =
    period === 'day'
      ? now.getTime() - 24 * 60 * 60 * 1000
      : period === 'week'
        ? now.getTime() - 7 * 24 * 60 * 60 * 1000
        : period === 'month'
          ? now.getTime() - 30 * 24 * 60 * 60 * 1000
          : 0;

  const summary: OrdersStatsSummary = {
    totalDeals: 0,
    confirmedDeals: 0,
    refundedDeals: 0,
    pendingDeals: 0,
    grossAmount: 0,
    confirmedAmount: 0,
    refundedAmount: 0,
  };

  for (const order of Object.values(orders)) {
    const orderMs = Date.parse(order.date);
    if (cutoffMs > 0 && (Number.isNaN(orderMs) || orderMs < cutoffMs)) {
      continue;
    }

    summary.totalDeals += 1;
    summary.grossAmount += order.price;

    if (
      order.status === ItemDealStatuses.CONFIRMED ||
      order.status === ItemDealStatuses.CONFIRMED_AUTOMATICALLY
    ) {
      summary.confirmedDeals += 1;
      summary.confirmedAmount += order.price;
    } else if (order.status === ItemDealStatuses.ROLLED_BACK) {
      summary.refundedDeals += 1;
      summary.refundedAmount += order.price;
    } else {
      summary.pendingDeals += 1;
    }
  }

  return summary;
}

export const ordersCachePlugin = {
  name: 'automation:orders-cache',
  inject: ['storage', 'playerok'],
  apply(ctx: Context): void {
    const log = ctx.logger('automation.orders');

    ctx.on('playerok/new-deal', async (event) => {
      try {
        if (event.deal.user.id === ctx.playerok.account?.id) return;

        const entry: CachedOrder = {
          id: event.deal.id,
          price: event.deal.item.price,
          status: event.deal.status,
          date: new Date().toISOString(),
          item_id: event.deal.item.id,
          item_name: event.deal.item.name,
        };
        await ctx.storage.runExclusive('cached_orders', () => {
          ctx.storage.update<CachedOrders>('cached_orders', (orders) => {
            orders[entry.id] = entry;
          });
        });
      } catch (err) {
        log.error(`Ошибка кэширования сделки: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ctx.on('playerok/deal-status-changed', async (event) => {
      try {
        if (event.deal.user.id === ctx.playerok.account?.id) return;
        await ctx.storage.runExclusive('cached_orders', () => {
          ctx.storage.update<CachedOrders>('cached_orders', (orders) => {
            if (orders[event.deal.id]) {
              orders[event.deal.id].status = event.deal.status;
            }
          });
        });
      } catch (err) {
        log.error(`Ошибка обновления статуса заказа: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  },
};
