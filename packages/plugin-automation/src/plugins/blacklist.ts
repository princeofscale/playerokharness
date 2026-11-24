import {
  formatTemplateLines,
  ItemDealStatuses,
  type Context,
  type DealEvent,
} from '@playerok/core';
import '@playerok/adapter';

export function buildTemplateVars(ctx: Context, event: Pick<DealEvent, 'deal' | 'chat'>): Record<string, unknown> {
  const buyer = event.deal.user ?? ctx.playerok.getChatOtherUser(event.chat);
  return {
    account: ctx.playerok.account?.profile ?? {},
    user: buyer ?? {},
    chat: event.chat,
    deal: event.deal,
    item: event.deal.item,
  };
}

export const blacklistPlugin = {
  name: 'automation:blacklist',
  inject: ['storage', 'blacklist', 'playerok'],
  apply(ctx: Context): void {
    const log = ctx.logger('automation.blacklist');

    ctx.on('playerok/new-deal', async (event) => {
      if (event.deal.user.id === ctx.playerok.account?.id) return;

      const username = ctx.playerok.getDealUsername(event);
      const entry = ctx.blacklist.getEntry(username);
      if (!entry) return;

      let refunded = false;
      const cfg = ctx.storage.getConfig();
      if (cfg.playerok.blacklist.auto_refund) {
        try {
          await ctx.playerok.updateDeal(event.deal.id, ItemDealStatuses.ROLLED_BACK);
          refunded = true;
        } catch (err) {
          log.error(
            `Не удалось вернуть сделку ${event.deal.id} покупателя из ЧС: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (refunded) {
          const tpl = ctx.storage.getMessages().blacklist_deal_refunded;
          if (tpl?.enabled && tpl.text.length > 0) {
            const text = formatTemplateLines(tpl.text, buildTemplateVars(ctx, event));
            await ctx.playerok.sendMessage(event.chat.id, text);
          }
        }
      }

      log.warn(
        `Сделка ${event.deal.id} от покупателя ${entry.username} из чёрного списка — ${refunded ? 'возвращена' : 'проигнорирована автоматизацией'}`,
      );

      await ctx.parallel('deal/blacklisted', {
        event,
        reason: entry.reason || 'не указана',
        refunded,
      });
    });
  },
};
