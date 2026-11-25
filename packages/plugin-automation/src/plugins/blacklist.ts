import {
  formatTemplateLines,
  ItemDealStatuses,
  type Context,
  type DealEvent,
} from '@pkh/core';
import '@pkh/adapter';
import '@pkh/plugin-retry-queue';
import { auditOnce } from '../audit.js';

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
      try {
        if (event.deal.user.id === ctx.playerok.account?.id) return;

        const username = ctx.playerok.getDealUsername(event);
        const entry = ctx.blacklist.getEntry(username);
        if (!entry) return;

        auditOnce(ctx, {
          action: 'blacklist.block',
          title: `Сделка ${event.deal.id}: покупатель в чёрном списке`,
          details: {
            dealId: event.deal.id,
            itemId: event.deal.item.id,
            amount: event.deal.item.price,
            buyer: entry.username,
          },
        });

        let refunded = false;
        const cfg = ctx.storage.getConfig();
        if (cfg.playerok.blacklist.auto_refund) {
          try {
            await ctx.playerok.updateDeal(event.deal.id, ItemDealStatuses.ROLLED_BACK);
            refunded = true;
            auditOnce(ctx, {
              action: 'blacklist.refund',
              title: `Сделка ${event.deal.id} возвращена: покупатель в чёрном списке`,
              details: {
                dealId: event.deal.id,
                itemId: event.deal.item.id,
                amount: event.deal.item.price,
              },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            auditOnce(ctx, {
              action: 'blacklist.refund',
              outcome: 'failed',
              title: `Не удалось вернуть сделку ${event.deal.id} покупателя из ЧС`,
              details: {
                dealId: event.deal.id,
                itemId: event.deal.item.id,
                amount: event.deal.item.price,
                error: msg,
              },
            });
            log.error(`Не удалось вернуть сделку ${event.deal.id} покупателя из ЧС: ${msg}`);
            const retryQueue = ctx.get('retryQueue', false);
            if (retryQueue) {
              await retryQueue.enqueue({
                kind: 'update_deal',
                payload: { dealId: event.deal.id, status: ItemDealStatuses.ROLLED_BACK },
                dedupeKey: `blacklist-refund:${event.deal.id}`,
                error: msg,
              });
            }
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
      } catch (err) {
        log.error(`Ошибка обработки ЧС по сделке ${event.deal.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  },
};
