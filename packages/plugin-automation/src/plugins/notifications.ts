import {
  escapeHtml,
  ItemDealStatuses,
  type Context,
} from '@playerok/core';
import '@playerok/adapter';

const DEAL_STATUS_RU: Record<string, string> = {
  [ItemDealStatuses.PAID]: 'Оплачено',
  [ItemDealStatuses.PENDING]: 'В ожидании',
  [ItemDealStatuses.SENT]: 'Товар отправлен',
  [ItemDealStatuses.CONFIRMED]: 'Выполнено',
  [ItemDealStatuses.CONFIRMED_AUTOMATICALLY]: 'Выполнено автоматически',
  [ItemDealStatuses.ROLLED_BACK]: 'Возврат',
};

export const notificationsPlugin = {
  name: 'automation:notifications',
  inject: ['storage', 'blacklist', 'playerok'],
  apply(ctx: Context): void {
    const canNotify = (
      eventKey: keyof ReturnType<typeof ctx.storage.getConfig>['playerok']['notifications']['events'],
    ): boolean => {
      const n = ctx.storage.getConfig().playerok.notifications;
      return Boolean(n.enabled && n.events[eventKey]);
    };

    ctx.on('playerok/new-message', async (event) => {
      if (!event.message.user || event.message.user.id === ctx.playerok.account?.id) return;
      const isSystem = ctx.playerok.isSupportOrSystemChat(event.chat.id);
      if (isSystem && !canNotify('new_system_message')) return;
      if (!isSystem && !canNotify('new_user_message')) return;

      const other = ctx.playerok.getChatOtherUser(event.chat);
      const blacklisted = !isSystem && ctx.blacklist.isBlacklisted(other?.username);

      const parts: string[] = [];
      if (event.message.images?.length) {
        parts.push(
          event.message.images
            .map((img, i) => `<a href="${img.url}">*Изображение ${i + 1}*</a>`)
            .join(', '),
        );
      }
      if (event.message.text) {
        parts.push(escapeHtml(event.message.text.trim()));
      }
      const bodyText = parts.join(' ') || '<i>Без текста</i>';

      await ctx.parallel('notify/log', {
        eventKey: isSystem ? 'new_system_message' : 'new_user_message',
        title: `${blacklisted ? '🚫 ' : ''}💬 Новое сообщение в <a href="https://playerok.com/chats/${event.chat.id}">чате</a>${blacklisted ? ' (покупатель в ЧС)' : ''}`,
        body: `<b>${escapeHtml(event.message.user.username)}:</b> <blockquote>${bodyText}</blockquote>`,
        buttons: [[{ text: '💬 Ответить', callbackData: `chat:reply:${event.chat.id}` }]],
      });
    });

    ctx.on('playerok/new-deal', async (event) => {
      if (event.deal.user.id === ctx.playerok.account?.id) return;
      if (ctx.blacklist.isBlacklisted(ctx.playerok.getDealUsername(event))) return;
      if (!canNotify('new_deal')) return;

      await ctx.parallel('notify/log', {
        eventKey: 'new_deal',
        title: `📋 Новая <a href="https://playerok.com/deal/${event.deal.id}">сделка</a>`,
        body: [
          `<b>👤 Покупатель:</b> ${escapeHtml(event.deal.user.username)}`,
          `<b>🛍️ Товар:</b> ${escapeHtml(event.deal.item.name || '-')}`,
          `<b>💰 Сумма:</b> ${event.deal.item.price}₽`,
        ].join('\n'),
        buttons: [
          [
            { text: '✅ Подтвердить', callbackData: `deal:confirm:${event.deal.id}` },
            { text: '📦 Возврат', callbackData: `deal:refund:${event.deal.id}` },
          ],
          [{ text: '💬 Чат', callbackData: `chat:view:${event.chat.id}` }],
        ],
      });
    });

    ctx.on('deal/blacklisted', async ({ event, reason, refunded }) => {
      if (!ctx.storage.getConfig().playerok.notifications.enabled) return;
      await ctx.parallel('notify/log', {
        eventKey: 'new_deal',
        title: `🚫 <a href="https://playerok.com/deal/${event.deal.id}">Сделка</a> от покупателя из ЧС`,
        body: [
          `<b>👤 Покупатель:</b> ${escapeHtml(event.deal.user.username)}`,
          `<b>📝 Причина ЧС:</b> ${escapeHtml(reason)}`,
          `<b>🛍️ Товар:</b> ${escapeHtml(event.deal.item.name || '-')}`,
          `<b>💰 Сумма:</b> ${event.deal.item.price}₽`,
          '',
          refunded
            ? '📦 Сделка автоматически возвращена'
            : '⚠️ Автоматизация не обрабатывала сделку — решите вручную',
        ].join('\n'),
        buttons: [
          ...(refunded ? [] : [[{ text: '📦 Оформить возврат', callbackData: `deal:refund:${event.deal.id}` }]]),
          [{ text: '💬 Чат', callbackData: `chat:view:${event.chat.id}` }],
        ],
      });
    });

    ctx.on('playerok/new-review', async (event) => {
      if (event.deal.user.id === ctx.playerok.account?.id) return;
      if (!canNotify('new_review') || !event.deal.review) return;

      const r = event.deal.review;
      const text = r.text ? `<blockquote>${escapeHtml(r.text)}</blockquote>` : '<i>Без текста</i>';
      await ctx.parallel('notify/log', {
        eventKey: 'new_review',
        title: `🌟 Новый отзыв в <a href="https://playerok.com/deal/${event.deal.id}">сделке</a>`,
        body: [
          `<b>👤 Оставил:</b> ${escapeHtml(r.creator.username)}`,
          `<b>✨ Оценка:</b> ${'⭐'.repeat(r.rating)}`,
          `<b>🏷️ Текст:</b> ${text}`,
        ].join('\n'),
        buttons: [[{ text: '💬 Ответить', callbackData: `chat:reply:${event.chat.id}` }]],
      });
    });

    ctx.on('playerok/deal-has-problem', async (event) => {
      if (event.deal.user.id === ctx.playerok.account?.id) return;
      if (!canNotify('new_problem')) return;

      await ctx.parallel('notify/log', {
        eventKey: 'new_problem',
        title: `⚠️ Новая проблема в <a href="https://playerok.com/deal/${event.deal.id}">сделке</a>`,
        body: [
          `<b>👤 Покупатель:</b> ${escapeHtml(event.deal.user.username)}`,
          `<b>🛍️ Товар:</b> ${escapeHtml(event.deal.item.name)}`,
        ].join('\n'),
        buttons: [
          [{ text: '📦 Возврат', callbackData: `deal:refund:${event.deal.id}` }],
          [{ text: '💬 Чат', callbackData: `chat:view:${event.chat.id}` }],
        ],
      });
    });

    ctx.on('playerok/deal-status-changed', async (event) => {
      if (event.deal.user.id === ctx.playerok.account?.id) return;
      if (!canNotify('deal_status_changed')) return;

      const label = DEAL_STATUS_RU[event.deal.status] ?? event.deal.status;
      await ctx.parallel('notify/log', {
        eventKey: 'deal_status_changed',
        title: `🔃 Статус <a href="https://playerok.com/deal/${event.deal.id}">сделки</a> изменился на «${label}»`,
        buttons: [[{ text: '📋 Открыть сделку', callbackData: `deal:view:${event.deal.id}` }]],
      });
    });

    ctx.on('item/restored', async (info) => {
      if (!canNotify('item_restored')) return;
      const lines: string[] = [];
      if (info.dataReplacedRemaining !== undefined) {
        lines.push(`🔄 Данные товара заменены\n💽 Осталось данных: ${info.dataReplacedRemaining}`);
      }
      if (!info.oldRemoved) {
        lines.push('⚠️ Старый товар не удалился — удалите вручную');
      }
      await ctx.parallel('notify/log', {
        eventKey: 'item_restored',
        title: `${info.recreated ? '🆕' : '♻️'} Товар <a href="https://playerok.com/products/${encodeURIComponent(info.slug)}">«${escapeHtml(info.name)}»</a> ${info.recreated ? 'пересоздан' : 'восстановлен'} (${info.isPremium ? 'премиум' : 'бесплатный'})`,
        body: lines.join('\n') || undefined,
      });
    });

    ctx.on('item/bumped', async (info) => {
      if (!canNotify('item_bumped')) return;
      await ctx.parallel('notify/log', {
        eventKey: 'item_bumped',
        title: `⬆️ Товар <a href="https://playerok.com/products/${encodeURIComponent(info.slug)}">«${escapeHtml(info.name)}»</a> поднят${info.reason ? ` (${escapeHtml(info.reason)})` : ''}. Позиция: ${info.previousPosition ?? '?'} → 1`,
      });
    });

    ctx.on('withdrawal/requested', async (info) => {
      if (!canNotify('withdrawal_requested')) return;
      await ctx.parallel('notify/log', {
        eventKey: 'withdrawal_requested',
        title: `💳 Транзакция на вывод ${info.amount}₽ успешно создана (${escapeHtml(info.provider)})`,
      });
    });
  },
};
