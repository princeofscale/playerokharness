import { itemMatchesBinding, type AutoDeliveryRule, type Context } from '@pkh/core';
import '@pkh/adapter';

export const autoDeliveryPlugin = {
  name: 'automation:auto-delivery',
  inject: ['storage', 'blacklist', 'playerok'],
  apply(ctx: Context): void {
    const log = ctx.logger('automation.delivery');

    ctx.on('playerok/new-deal', async (event) => {
      try {
        if (event.deal.user.id === ctx.playerok.account?.id) return;
        if (ctx.blacklist.isBlacklisted(ctx.playerok.getDealUsername(event))) return;

        // Serialize per-delivery queue + persistent idempotency guard against duplicate events
        await ctx.storage.runExclusive('auto_deliveries', async () => {
          if (ctx.storage.isDealDelivered(event.deal.id)) {
            log.debug(`Сделка ${event.deal.id} уже была выдана ранее — пропуск дубликата`);
            return;
          }

          const deliveries = ctx.storage.getAutoDeliveries();
          let anyDelivered = false;

          for (let i = 0; i < deliveries.length; i++) {
            const rule = deliveries[i];
            if (!itemMatchesBinding(event.deal.item, rule)) continue;

            if (rule.piece) {
              const goods = rule.goods ?? [];
              if (goods.length === 0) {
                log.warn(`Авто-выдача по товару «${event.deal.item.name}»: закончились поштучные товары!`);
                continue;
              }
              const good = goods[0];
              const sent = await ctx.playerok.sendMessage(event.chat.id, good);
              if (sent) {
                anyDelivered = true;
                let remaining = 0;
                ctx.storage.update<AutoDeliveryRule[]>('auto_deliveries', (list) => {
                  const target = list[i];
                  if (target?.goods) {
                    const idx = target.goods.indexOf(good);
                    if (idx !== -1) target.goods.splice(idx, 1);
                    remaining = target.goods.length;
                  }
                });
                log.info(
                  `Покупателю ${event.deal.user.username} выдан товар «${good}». Остаток: ${remaining}`,
                );
              }
            } else {
              const lines = rule.message ?? [];
              if (lines.length === 0) continue;
              const sent = await ctx.playerok.sendMessage(event.chat.id, lines.join('\n'));
              if (sent) {
                anyDelivered = true;
                log.info(`Покупателю ${event.deal.user.username} отправлено сообщение авто-выдачи`);
              }
            }
          }

          if (anyDelivered) {
            ctx.storage.markDealDelivered(event.deal.id);
          }
        });
      } catch (err) {
        log.error(
          `Ошибка авто-выдачи по сделке ${event.deal.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  },
};
