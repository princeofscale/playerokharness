import {
  formatTemplateLines,
  type Chat,
  type Context,
  type ItemDeal,
} from '@pkh/core';
import '@pkh/adapter';

function renderNamedMessage(
  ctx: Context,
  messageKey: string,
  extraVars: Record<string, unknown>,
): string | null {
  const messages = ctx.storage.getMessages();
  const entry = messages[messageKey];
  if (!entry || !entry.enabled || entry.text.length === 0) return null;
  return formatTemplateLines(entry.text, {
    account: ctx.playerok.account?.profile ?? {},
    ...extraVars,
  });
}

function dealVars(ctx: Context, chat: Chat, deal: ItemDeal, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: deal.user ?? ctx.playerok.getChatOtherUser(chat) ?? {},
    chat,
    deal,
    item: deal.item,
    ...extra,
  };
}

export const messagesPlugin = {
  name: 'automation:messages',
  inject: ['storage', 'blacklist', 'playerok'],
  apply(ctx: Context): void {
    const log = ctx.logger('automation.messages');
    const isBlacklistedUser = (username?: string | null) => ctx.blacklist.isBlacklisted(username);

    ctx.on('playerok/new-message', async (event) => {
      try {
        if (!event.message.user) return;
        if (event.message.user.id === ctx.playerok.account?.id) return;
        if (ctx.playerok.isSupportOrSystemChat(event.chat.id)) return;

        const otherUser = ctx.playerok.getChatOtherUser(event.chat) ?? event.message.user;
        if (isBlacklistedUser(otherUser.username)) return;

        const text = event.message.text?.trim();
        if (!text) return;

        const isNewUser = await ctx.storage.runExclusive('initialized_users', () => {
          const initialized = ctx.storage.getInitializedUsers();
          if (initialized.includes(event.message.user.id)) return false;
          ctx.storage.update<string[]>('initialized_users', (list) => {
            if (!list.includes(event.message.user.id)) list.push(event.message.user.id);
          });
          return true;
        });

        const lower = text.toLowerCase();
        const isEscalation = lower === '!продавец' || lower === '!seller';
        const commands = ctx.storage.getCustomCommands();
        const matchedKey = Object.keys(commands).find((k) => k.toLowerCase() === lower);

        // The greeting used to swallow the buyer's very first message, so a brand-new buyer
        // whose first message was a documented command (!продавец, !инфо, …) never got it
        // executed — the welcome text answered instead. Greet plain text only.
        if (isNewUser && !isEscalation && !matchedKey) {
          const greeting = renderNamedMessage(ctx, 'first_message', {
            user: otherUser,
            chat: event.chat,
          });
          if (greeting) {
            await ctx.playerok.sendMessage(event.chat.id, greeting);
          }
          return;
        }

        if (isEscalation) {
          await ctx.parallel('notify/call-seller', {
            username: event.message.user.username,
            chatId: event.chat.id,
          });
          const reply = renderNamedMessage(ctx, 'cmd_seller', {
            user: otherUser,
            chat: event.chat,
          });
          if (reply) {
            await ctx.playerok.sendMessage(event.chat.id, reply);
          }
          return;
        }

        if (matchedKey) {
          const lines = commands[matchedKey];
          if (lines && lines.length > 0) {
            const reply = formatTemplateLines(lines, {
              account: ctx.playerok.account?.profile ?? {},
              user: otherUser,
              chat: event.chat,
            });
            await ctx.playerok.sendMessage(event.chat.id, reply);
          }
        }
      } catch (err) {
        log.error(`Ошибка обработки сообщения: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ctx.on('playerok/new-deal', async (event) => {
      try {
        if (event.deal.user.id === ctx.playerok.account?.id) return;
        if (isBlacklistedUser(ctx.playerok.getDealUsername(event))) return;

        const newDealMsg = renderNamedMessage(ctx, 'new_deal', dealVars(ctx, event.chat, event.deal));
        if (newDealMsg) {
          await ctx.playerok.sendMessage(event.chat.id, newDealMsg);
        }

        if (!ctx.playerok.isSupportOrSystemChat(event.chat.id)) {
          const isNew = await ctx.storage.runExclusive('initialized_users', () => {
            const initialized = ctx.storage.getInitializedUsers();
            if (initialized.includes(event.deal.user.id)) return false;
            ctx.storage.update<string[]>('initialized_users', (list) => {
              if (!list.includes(event.deal.user.id)) list.push(event.deal.user.id);
            });
            return true;
          });
          if (isNew) {
            const greeting = renderNamedMessage(ctx, 'first_message', dealVars(ctx, event.chat, event.deal));
            if (greeting) {
              await ctx.playerok.sendMessage(event.chat.id, greeting);
            }
          }
        }
      } catch (err) {
        log.error(`Ошибка авто-ответа на сделку: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ctx.on('playerok/item-sent', async (event) => {
      try {
        if (event.deal.user.id === ctx.playerok.account?.id) return;
        if (isBlacklistedUser(ctx.playerok.getDealUsername(event))) return;
        const msg = renderNamedMessage(ctx, 'deal_sent', dealVars(ctx, event.chat, event.deal));
        if (msg) await ctx.playerok.sendMessage(event.chat.id, msg);
      } catch (err) {
        log.error(`Ошибка deal_sent: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ctx.on('playerok/deal-confirmed', async (event) => {
      try {
        if (event.deal.user.id === ctx.playerok.account?.id) return;
        if (isBlacklistedUser(ctx.playerok.getDealUsername(event))) return;
        const msg = renderNamedMessage(ctx, 'deal_confirmed', dealVars(ctx, event.chat, event.deal));
        if (msg) await ctx.playerok.sendMessage(event.chat.id, msg);
      } catch (err) {
        log.error(`Ошибка deal_confirmed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ctx.on('playerok/deal-rolled-back', async (event) => {
      try {
        if (event.deal.user.id === ctx.playerok.account?.id) return;
        if (isBlacklistedUser(ctx.playerok.getDealUsername(event))) return;
        const msg = renderNamedMessage(ctx, 'deal_refunded', dealVars(ctx, event.chat, event.deal));
        if (msg) await ctx.playerok.sendMessage(event.chat.id, msg);
      } catch (err) {
        log.error(`Ошибка deal_refunded: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ctx.on('playerok/deal-has-problem', async (event) => {
      try {
        if (event.deal.user.id === ctx.playerok.account?.id) return;
        if (isBlacklistedUser(ctx.playerok.getDealUsername(event))) return;
        const msg = renderNamedMessage(ctx, 'deal_has_problem', dealVars(ctx, event.chat, event.deal));
        if (msg) await ctx.playerok.sendMessage(event.chat.id, msg);
      } catch (err) {
        log.error(`Ошибка deal_has_problem: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ctx.on('playerok/new-review', async (event) => {
      try {
        if (event.deal.user.id === ctx.playerok.account?.id) return;
        if (isBlacklistedUser(ctx.playerok.getDealUsername(event))) return;
        const msg = renderNamedMessage(
          ctx,
          'new_review',
          dealVars(ctx, event.chat, event.deal, { review_rating: event.deal.review?.rating ?? 5 }),
        );
        if (msg) await ctx.playerok.sendMessage(event.chat.id, msg);
      } catch (err) {
        log.error(`Ошибка new_review: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  },
};
