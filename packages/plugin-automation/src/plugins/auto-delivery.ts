import { bindingKey, itemMatchesBinding, type AutoDeliveryRule, type Context } from '@pkh/core';
import '@pkh/adapter';
import '@pkh/plugin-retry-queue';

export const autoDeliveryPlugin = {
  name: 'automation:auto-delivery',
  inject: ['storage', 'blacklist', 'playerok'],
  apply(ctx: Context): void {
    const log = ctx.logger('automation.delivery');

    /**
     * Списывает выданный поштучный товар по стабильному ключу привязки, а не по индексу:
     * между чтением списка правил и записью есть await (sendMessage), за который правила
     * могли изменить из Telegram — по индексу списался бы товар из чужого правила.
     * Возвращает остаток или null, если правило/товар уже не найдены.
     */
    const consumePiece = (index: number, key: string, good: string): number | null => {
      let remaining: number | null = null;
      ctx.storage.update<AutoDeliveryRule[]>('auto_deliveries', (list) => {
        const target =
          list[index] && bindingKey(list[index]) === key
            ? list[index]
            : list.find((entry) => bindingKey(entry) === key);
        const goods = target?.goods;
        if (!goods) return;
        const idx = goods.indexOf(good);
        if (idx === -1) return;
        goods.splice(idx, 1);
        remaining = goods.length;
      });
      return remaining;
    };

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
          const retryQueue = ctx.get('retryQueue', false);
          let anyDelivered = false;

          for (let i = 0; i < deliveries.length; i++) {
            const rule = deliveries[i];
            if (!itemMatchesBinding(event.deal.item, rule)) continue;
            const ruleKey = bindingKey(rule);

            if (rule.piece) {
              const goods = rule.goods ?? [];
              if (goods.length === 0) {
                log.warn(`Авто-выдача по товару «${event.deal.item.name}»: закончились поштучные товары!`);
                continue;
              }
              const good = goods[0];
              let sent = null;
              let sendError: string | undefined;
              try {
                sent = await ctx.playerok.sendMessage(event.chat.id, good);
              } catch (err) {
                sendError = err instanceof Error ? err.message : String(err);
              }

              if (sent) {
                anyDelivered = true;
                const remaining = consumePiece(i, ruleKey, good);
                if (remaining === null) {
                  log.warn(
                    `Товар «${good}» выдан, но не найден в правиле авто-выдачи — проверьте остатки вручную`,
                  );
                } else {
                  log.info(
                    `Покупателю ${event.deal.user.username} выдан товар «${good}». Остаток: ${remaining}`,
                  );
                }
              } else if (retryQueue) {
                // Reserve the piece item immediately so it is never handed to another buyer while retry is pending
                anyDelivered = true;
                if (consumePiece(i, ruleKey, good) === null) {
                  log.warn(
                    `Товар «${good}» зарезервирован под повтор, но не найден в правиле авто-выдачи`,
                  );
                }
                await retryQueue.enqueue({
                  kind: 'send_message',
                  payload: { chatId: event.chat.id, text: good },
                  dedupeKey: `delivery:${event.deal.id}:${i}`,
                  error: sendError ?? 'sendMessage failed during auto-delivery',
                });
              }
            } else {
              const lines = rule.message ?? [];
              if (lines.length === 0) continue;
              const text = lines.join('\n');
              let sent = null;
              let sendError: string | undefined;
              try {
                sent = await ctx.playerok.sendMessage(event.chat.id, text);
              } catch (err) {
                sendError = err instanceof Error ? err.message : String(err);
              }

              if (sent) {
                anyDelivered = true;
                log.info(`Покупателю ${event.deal.user.username} отправлено сообщение авто-выдачи`);
              } else if (retryQueue) {
                anyDelivered = true;
                await retryQueue.enqueue({
                  kind: 'send_message',
                  payload: { chatId: event.chat.id, text },
                  dedupeKey: `delivery:${event.deal.id}:${i}`,
                  error: sendError ?? 'sendMessage failed during auto-delivery',
                });
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
