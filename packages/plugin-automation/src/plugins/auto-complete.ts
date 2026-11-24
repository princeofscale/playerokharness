import { ItemDealStatuses, itemMatchesAnyBinding, type Context } from '@playerok/core';
import '@playerok/adapter';

export const autoCompletePlugin = {
  name: 'automation:auto-complete',
  inject: ['storage', 'blacklist', 'playerok'],
  apply(ctx: Context): void {
    const log = ctx.logger('automation.complete');

    ctx.on('playerok/new-deal', async (event) => {
      if (event.deal.user.id === ctx.playerok.account?.id) return;
      if (ctx.blacklist.isBlacklisted(ctx.playerok.getDealUsername(event))) return;

      const cfg = ctx.storage.getConfig().playerok.auto_complete_deals;
      if (!cfg.enabled) return;

      let item = event.deal.item;
      if (!item.name && item.id) {
        try {
          item = await ctx.playerok.getItem({ id: item.id });
        } catch {
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
        log.info(`Сделка ${event.deal.id} подтверждена автоматически`);
      } catch (err) {
        log.error(
          `Ошибка авто-подтверждения сделки ${event.deal.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  },
};
