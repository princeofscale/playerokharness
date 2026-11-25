import { ItemDealStatuses, itemMatchesAnyBinding, type Context } from '@pkh/core';
import '@pkh/adapter';
import '@pkh/plugin-retry-queue';
import { auditOnce } from '../audit.js';

export const autoCompletePlugin = {
  name: 'automation:auto-complete',
  inject: ['storage', 'blacklist', 'playerok'],
  apply(ctx: Context): void {
    const log = ctx.logger('automation.complete');

    ctx.on('playerok/new-deal', async (event) => {
      try {
        if (event.deal.user.id === ctx.playerok.account?.id) return;
        if (ctx.blacklist.isBlacklisted(ctx.playerok.getDealUsername(event))) return;

        const cfg = ctx.storage.getConfig().playerok.auto_complete_deals;
        if (!cfg.enabled) return;

        await ctx.storage.runExclusive('idempotency', async () => {
          if (ctx.storage.isDealCompleted(event.deal.id)) {
            log.debug(`Сделка ${event.deal.id} уже подтверждалась ранее — пропуск`);
            return;
          }

          let item = event.deal.item;
          if (!item.name && item.id) {
            try {
              item = await ctx.playerok.getItem({ id: item.id });
            } catch (err) {
              // Silently returning left the deal uncompleted with no trace anywhere.
              log.warn(
                `Не удалось получить товар ${item.id} для сделки ${event.deal.id}: ${err instanceof Error ? err.message : String(err)} — авто-подтверждение отложено`,
              );
              return;
            }
          }

          const lists = ctx.storage.getAutoCompleteDeals();
          const included = itemMatchesAnyBinding(item, lists.included);
          const excluded = itemMatchesAnyBinding(item, lists.excluded);

          const matched = (cfg.all && !excluded) || (!cfg.all && included);
          if (!matched) return;

          try {
            await ctx.playerok.updateDeal(event.deal.id, ItemDealStatuses.SENT);
            ctx.storage.markDealCompleted(event.deal.id);
            auditOnce(ctx, {
              action: 'auto-complete.sent',
              title: `Сделка ${event.deal.id} подтверждена автоматически`,
              details: {
                dealId: event.deal.id,
                itemId: event.deal.item.id,
                amount: event.deal.item.price,
              },
            });
            log.info(`Сделка ${event.deal.id} подтверждена автоматически`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            auditOnce(ctx, {
              action: 'auto-complete.failed',
              outcome: 'failed',
              title: `Ошибка авто-подтверждения сделки ${event.deal.id}`,
              details: {
                dealId: event.deal.id,
                itemId: event.deal.item.id,
                amount: event.deal.item.price,
                error: msg,
              },
            });
            log.error(`Ошибка авто-подтверждения сделки ${event.deal.id}: ${msg}`);
            const retryQueue = ctx.get('retryQueue', false);
            if (retryQueue) {
              await retryQueue.enqueue({
                kind: 'update_deal',
                payload: { dealId: event.deal.id, status: ItemDealStatuses.SENT },
                dedupeKey: `complete:${event.deal.id}`,
                error: msg,
              });
            }
          }
        });
      } catch (err) {
        log.error(
          `Ошибка авто-подтверждения сделки ${event.deal.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  },
};
