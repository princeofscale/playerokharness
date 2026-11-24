/**
 * Пример внешнего плагина для PlayerOK Universal v2 (Cordis 4).
 * Скопируйте этот файл в папку `plugins/` рядом с конфигом бота — он загрузится автоматически.
 */

export const meta = {
  id: 'hello-plugin',
  name: 'Hello Plugin',
  version: '1.0.0',
  description: 'Пример внешнего плагина: логирует новые сделки и отвечает на команду !ping',
  authors: 'PlayerOK Universal v2',
};

export const inject = ['playerok'];

export function apply(ctx) {
  const log = ctx.logger('plugin.hello');
  log.info('Hello Plugin активирован!');

  // Подписка на входящие сообщения PlayerOK (автоматически снимается при выключении плагина!)
  ctx.on('playerok/new-message', async (event) => {
    if (event.message.text?.trim().toLowerCase() === '!ping') {
      await ctx.playerok.sendMessage(event.chat.id, '🏓 Pong от внешнего Cordis-плагина!');
    }
  });

  // Подписка на новые сделки
  ctx.on('playerok/new-deal', (event) => {
    log.info(`Внешний плагин увидел новую сделку #${event.deal.id} на сумму ${event.deal.item.price}₽`);
  });
}
