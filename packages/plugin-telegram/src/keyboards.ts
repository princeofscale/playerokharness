import { InlineKeyboard } from 'grammy';
import {
  bindingLinks,
  bindingTitle,
  escapeHtml,
  ItemDealStatuses,
  ItemStatuses,
  maskProxy,
  VERSION,
  type AccountInfo,
  type AutoDeliveryRule,
  type BindingEntry,
  type BlacklistEntryWithUser,
  type BotConfig,
  type CachedOrders,
  type Chat,
  type ChatMessage,
  type CustomCommandsSettings,
  type DataReplacementRule,
  type FastReply,
  type GitHubRelease,
  type InlineButton,
  type ItemDeal,
  type ItemProfile,
  type LoadedPluginRecord,
  type MessagesSettings,
  type MessageTemplate,
  type Review,
  type SbpBankMember,
  type SetupProblem,
  type Transaction,
  type VerifiedCard,
} from '@pkh/core';
import { computeOrdersStats, type StatsPeriod, type TrackedPosition } from '@pkh/plugin-automation';
import type { RetryTask } from '@pkh/plugin-retry-queue';
import { fitCallback } from './callbacks.js';
import type { BindingBucket, BindingStoreKey } from './fsm.js';

export interface RenderedView {
  text: string;
  keyboard: InlineKeyboard;
}

const PAGE_SIZE = 8;

export function paginate<T>(items: T[], page: number, pageSize = PAGE_SIZE): {
  slice: T[];
  page: number;
  totalPages: number;
} {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * pageSize;
  return {
    slice: items.slice(start, start + pageSize),
    page: safePage,
    totalPages,
  };
}

function appendPager(kb: InlineKeyboard, page: number, totalPages: number, prefix: string): void {
  if (totalPages <= 1) return;
  if (page > 0) kb.text('◀️', `${prefix}:${page - 1}`);
  kb.text(`${page + 1} / ${totalPages}`, 'noop');
  if (page < totalPages - 1) kb.text('▶️', `${prefix}:${page + 1}`);
  kb.row();
}

export function toGrammyKeyboard(rows?: InlineButton[][]): InlineKeyboard | undefined {
  if (!rows || rows.length === 0) return undefined;
  const kb = new InlineKeyboard();
  rows.forEach((row, idx) => {
    for (const btn of row) {
      if (btn.url) {
        kb.url(btn.text, btn.url);
      } else if (btn.callbackData) {
        kb.text(btn.text, btn.callbackData);
      }
    }
    if (idx < rows.length - 1) kb.row();
  });
  return kb;
}

const boolIcon = (v: boolean) => (v ? '🟢' : '🔴');

export function renderSetupMode(problem: SetupProblem): RenderedView {
  const text = [
    '<b>🩺 Режим настройки PlayerOK Harness</b>',
    '',
    '⚠️ <b>Работа с PlayerOK приостановлена:</b>',
    `<blockquote>${escapeHtml(problem.text)}</blockquote>`,
    '',
    'Исправьте параметры подключения ниже и нажмите <b>«Проверить и запустить»</b>.',
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('🍪 Указать Cookies', 'fsm:conn:pl_cookies')
    .text('🌐 Прокси PlayerOK', 'fsm:conn:pl_proxy').row()
    .text('🖥️ User-Agent', 'fsm:conn:pl_ua')
    .text('🛜 Все параметры', 'menu:conn').row()
    .text('🚀 Проверить и запустить', 'action:setup_launch').row()
    .text('🏠 В меню (без PlayerOK)', 'menu:main');

  return { text, keyboard: kb };
}

export function renderMainMenu(dryRun = false, setupProblem: SetupProblem | null = null): RenderedView {
  const modeBadge = setupProblem
    ? ' <i>(SETUP MODE ⚠️)</i>'
    : dryRun
      ? ' <i>(DRY-RUN)</i>'
      : '';
  const text = [
    `<b>🏠 PlayerOK Harness</b> v${VERSION}${modeBadge}`,
    'Ваш модульный бот-помощник для PlayerOK (Cordis 4 + TS)',
    ...(setupProblem ? ['', `⚠️ <i>PlayerOK: ${escapeHtml(setupProblem.text)}</i>`] : []),
  ].join('\n');

  const kb = new InlineKeyboard();
  if (setupProblem) {
    kb.text('🩺 Починить подключение PlayerOK', 'menu:setup').row();
  }
  kb.text('━━━ НАСТРОЙКИ ━━━', 'noop').row()
    .text('💬 Сообщения', 'menu:messages').text('❗ Команды', 'menu:commands').row()
    .text('🚀 Авто-выдача', 'deliv:list:0').text('⬆️ Авто-поднятие', 'menu:bump').row()
    .text('♻️ Восстановление', 'menu:restore').text('☑️ Подтверждение', 'menu:complete').row()
    .text('🔄 Замена данных', 'dr:list:0').text('💸 Авто-вывод', 'menu:withdrawal').row()
    .text('⚡ Быстрые ответы', 'menu:fast_replies').text('🔔 Уведомления', 'menu:notifications').row()
    .text('🚫 Чёрный список', 'bl:list:0').text('🔧 Прочее', 'menu:other').row()
    .text('🛜 Соединение и API', 'menu:conn').row()
    .text('━━━ УПРАВЛЕНИЕ ━━━', 'noop').row()
    .text('👤 Профиль', 'menu:profile').text('📊 Статистика', 'stats:day').row()
    .text('💬 Чаты', 'chats:page:0').text('📋 Сделки', 'deals:ALL:0').row()
    .text('🛍️ Товары', 'items:APPROVED:0').text('💳 Транзакции', 'txs:page:0').row()
    .text('🌟 Отзывы', 'reviews:0:0').row()
    .text('━━━ СИСТЕМА ━━━', 'noop').row()
    .text('🔌 Плагины', 'menu:modules').text('🗒️ Логи', 'menu:logs').row()
    .text('🔁 Очередь повторов', 'menu:retry_queue').text('🔃 Обновления', 'menu:updates').row()
    .text('🔑 Авторизации', 'menu:signed_users').text('🗂 Конфиги', 'menu:configs');
  return { text, keyboard: kb };
}

export function renderNotificationsSettings(cfg: BotConfig): RenderedView {
  const n = cfg.playerok.notifications;
  const e = n.events;
  const text = [
    '<b>🔔 Настройки уведомлений</b>',
    '',
    `Статус: ${boolIcon(n.enabled)} ${n.enabled ? 'Включены' : 'Выключены'}`,
    `Чат уведомлений: <code>${escapeHtml(String(n.chat_id || 'Личные сообщения владельцев'))}</code>`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(`${boolIcon(n.enabled)} Уведомления`, 'toggle:notif:enabled')
    .text('✏️ Чат ID', 'fsm:conn:notif_chat_id').row()
    .text(`${boolIcon(e.new_user_message)} Сообщения юзеров`, 'toggle:notif:new_user_message')
    .text(`${boolIcon(e.new_system_message)} Системные`, 'toggle:notif:new_system_message').row()
    .text(`${boolIcon(e.new_deal)} Новые сделки`, 'toggle:notif:new_deal')
    .text(`${boolIcon(e.deal_status_changed)} Статус сделки`, 'toggle:notif:deal_status_changed').row()
    .text(`${boolIcon(e.new_review)} Отзывы`, 'toggle:notif:new_review')
    .text(`${boolIcon(e.new_problem)} Проблемы`, 'toggle:notif:new_problem').row()
    .text(`${boolIcon(e.item_restored)} Восстановление`, 'toggle:notif:item_restored')
    .text(`${boolIcon(e.item_bumped)} Поднятие`, 'toggle:notif:item_bumped').row()
    .text(`${boolIcon(e.withdrawal_requested)} Вывод средств`, 'toggle:notif:withdrawal_requested').row()
    .text('⬅️ В меню', 'menu:main');
  return { text, keyboard: kb };
}

export function renderRestoreSettings(cfg: BotConfig): RenderedView {
  const r = cfg.playerok.auto_restore_items;
  const text = [
    '<b>♻️ Авто-восстановление товаров</b>',
    '',
    `Проданные: ${boolIcon(r.sold)} | Истёкшие: ${boolIcon(r.expired)}`,
    `Режим списка: ${r.all ? 'Все (кроме исключений)' : 'Только включённые'}`,
    `Бесплатные: ${boolIcon(r.free)} | Премиум: ${boolIcon(r.premium)}`,
    `Статус публикации: <b>${r.publish_status}</b>`,
    `Пересоздание (recreate): ${boolIcon(r.recreate)}`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(`${boolIcon(r.sold)} Проданные`, 'toggle:restore:sold')
    .text(`${boolIcon(r.expired)} Истёкшие`, 'toggle:restore:expired').row()
    .text(`${boolIcon(r.all)} Все товары`, 'toggle:restore:all')
    .text(`${boolIcon(r.recreate)} Пересоздание`, 'toggle:restore:recreate').row()
    .text(`${boolIcon(r.free)} Бесплатные`, 'toggle:restore:free')
    .text(`${boolIcon(r.premium)} Премиум`, 'toggle:restore:premium').row()
    .text(`🔄 Статус: ${r.publish_status}`, 'toggle:restore:publish_status')
    .text('🔄 Замена данных', 'dr:list:0').row()
    .text('➕ Включённые', 'bind:auto_restore_items:included:0')
    .text('➖ Исключённые', 'bind:auto_restore_items:excluded:0').row()
    .text('▶️ Восстановить истёкшие сейчас', 'action:restore_expired').row()
    .text('⬅️ В меню', 'menu:main');
  return { text, keyboard: kb };
}

export function renderCompleteSettings(cfg: BotConfig): RenderedView {
  const c = cfg.playerok.auto_complete_deals;
  const text = [
    '<b>☑️ Авто-подтверждение сделок</b>',
    '',
    `Статус: ${boolIcon(c.enabled)} ${c.enabled ? 'Включено' : 'Выключено'}`,
    `Режим: ${c.all ? 'Все товары (кроме исключений)' : 'Только включённые'}`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(`${boolIcon(c.enabled)} Авто-подтверждение`, 'toggle:complete:enabled')
    .text(`${boolIcon(c.all)} Для всех`, 'toggle:complete:all').row()
    .text('➕ Включённые', 'bind:auto_complete_deals:included:0')
    .text('➖ Исключённые', 'bind:auto_complete_deals:excluded:0').row()
    .text('⬅️ В меню', 'menu:main');
  return { text, keyboard: kb };
}

export function renderBumpSettings(cfg: BotConfig, positions: TrackedPosition[]): RenderedView {
  const b = cfg.playerok.auto_bump_items;
  const text = [
    '<b>⬆️ Авто-поднятие товаров</b>',
    '',
    `Статус: ${boolIcon(b.enabled)} | Режим: <b>${b.mode === 'position' ? 'По позиции' : 'По интервалу'}</b>`,
    `Интервал: <b>${b.interval}с</b> | Порог позиции: <b>${b.position}</b>`,
    `Кулдаун: <b>${b.cooldown}с</b> | Проверка позиций: <b>${b.check_interval}с</b>`,
    `Ночной режим: ${boolIcon(b.night.enabled)} (${b.night.time_from}–${b.night.time_to}, инт. ${b.night.interval}с, поз. ${b.night.position})`,
    `Охват: ${b.all ? 'Все премиум-товары' : 'Только включённые'}`,
    `Отслеживаемых позиций: <b>${positions.length}</b>`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(`${boolIcon(b.enabled)} Авто-поднятие`, 'toggle:bump:enabled')
    .text(`🔀 Режим: ${b.mode}`, 'toggle:bump:mode').row()
    .text(`${boolIcon(b.all)} Все товары`, 'toggle:bump:all')
    .text(`${boolIcon(b.night.enabled)} Ночной режим`, 'toggle:bump:night').row()
    .text(`⏱ Инт: ${b.interval}с`, 'fsm:bump_num:interval')
    .text(`🎯 Поз: ${b.position}`, 'fsm:bump_num:position').row()
    .text(`❄️ Кулд: ${b.cooldown}с`, 'fsm:bump_num:cooldown')
    .text(`🔍 Чек: ${b.check_interval}с`, 'fsm:bump_num:check_interval').row()
    .text(`🌙 Инт: ${b.night.interval}с`, 'fsm:bump_num:night_interval')
    .text(`🌙 Поз: ${b.night.position}`, 'fsm:bump_num:night_position').row()
    .text(`🌙 С: ${b.night.time_from}`, 'fsm:bump_time:time_from')
    .text(`🌙 До: ${b.night.time_to}`, 'fsm:bump_time:time_to').row()
    .text('➕ Включённые', 'bind:auto_bump_items:included:0')
    .text('➖ Исключённые', 'bind:auto_bump_items:excluded:0').row()
    .text('📍 Позиции товаров', 'menu:bump_positions')
    .text('▶️ Поднять сейчас', 'action:bump_now').row()
    .text('⬅️ В меню', 'menu:main');
  return { text, keyboard: kb };
}

export function renderBindingsList(
  store: BindingStoreKey,
  bucket: BindingBucket,
  entries: BindingEntry[],
  page: number,
): RenderedView {
  const titles: Record<BindingStoreKey, string> = {
    auto_bump_items: 'Авто-поднятие',
    auto_restore_items: 'Авто-восстановление',
    auto_complete_deals: 'Авто-подтверждение',
  };
  const backTarget: Record<BindingStoreKey, string> = {
    auto_bump_items: 'menu:bump',
    auto_restore_items: 'menu:restore',
    auto_complete_deals: 'menu:complete',
  };
  const { slice, page: safePage, totalPages } = paginate(entries, page);
  const offset = safePage * PAGE_SIZE;

  const lines = slice.length
    ? slice.map((e, i) => `${offset + i + 1}. ${bindingLinks(e)}`)
    : ['<i>Список пуст.</i>'];

  const kb = new InlineKeyboard()
    .text('➕ Добавить (ссылка / ID / фраза)', `fsm:bind:${store}:${bucket}`).row();
  slice.forEach((e, i) => {
    const idx = offset + i;
    kb.text(`🗑 #${idx + 1} ${bindingTitle(e).slice(0, 22)}`, `bind_del:${store}:${bucket}:${idx}:${safePage}`).row();
  });
  appendPager(kb, safePage, totalPages, `bind:${store}:${bucket}`);
  kb.text('⬅️ Назад', backTarget[store]);

  return {
    text: `<b>${titles[store]} — ${bucket === 'included' ? 'Включённые' : 'Исключённые'} (${entries.length})</b>\n\n${lines.join('\n')}`,
    keyboard: kb,
  };
}

export function renderBumpPositions(positions: TrackedPosition[]): RenderedView {
  const lines = positions.length
    ? positions.map(
        (p) =>
          `• <a href="https://playerok.com/products/${encodeURIComponent(p.slug)}">${escapeHtml(p.name)}</a> — <b>#${p.position}</b> (streak: ${p.streak})`,
      )
    : ['<i>Нет отслеживаемых позиций. Запустите проверку в режиме position.</i>'];
  return {
    text: `<b>📍 Позиции товаров</b>\n\n${lines.join('\n')}`,
    keyboard: new InlineKeyboard()
      .text('🔄 Проверить позиции', 'action:check_positions').row()
      .text('⬅️ Назад', 'menu:bump'),
  };
}

export function renderWithdrawalSettings(cfg: BotConfig): RenderedView {
  const w = cfg.playerok.auto_withdrawal;
  const credsDetail =
    w.credentials_type === 'card'
      ? `Карта ID: <code>${escapeHtml(w.card_id || 'не выбрана')}</code>`
      : w.credentials_type === 'sbp'
        ? `СБП: <code>${escapeHtml(w.sbp_phone_number || '—')}</code> (банк: <code>${escapeHtml(w.sbp_bank_id || '—')}</code>)`
        : w.credentials_type === 'usdt'
          ? `USDT TRC20: <code>${escapeHtml(w.usdt_address || '—')}</code>`
          : 'Не настроен';

  const text = [
    '<b>💸 Авто-вывод средств</b>',
    '',
    `Статус: ${boolIcon(w.enabled)}`,
    `Интервал: <b>${w.interval}с</b>`,
    `Реквизиты: ${credsDetail}`,
    `Последний запуск: <code>${w.last_time || 'никогда'}</code>`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(`${boolIcon(w.enabled)} Авто-вывод`, 'toggle:withdrawal:enabled')
    .text(`⏱ Инт: ${w.interval}с`, 'fsm:withdraw:interval').row()
    .text('💳 Карта РФ', 'withdraw:cards')
    .text('🏦 СБП', 'withdraw:sbp')
    .text('🪙 USDT', 'fsm:withdraw:usdt').row()
    .text('▶️ Запросить вывод сейчас', 'action:withdraw_now').row()
    .text('⬅️ В меню', 'menu:main');
  return { text, keyboard: kb };
}

export function renderWithdrawalCards(cards: VerifiedCard[]): RenderedView {
  const kb = new InlineKeyboard();
  for (const c of cards) {
    kb.text(
      `💳 ${c.cardFirstSix}****${c.cardLastFour} (${c.cardType ?? 'CARD'})`,
      fitCallback('withdraw:set_card', c.id),
    ).row();
  }
  kb.text('⬅️ Назад', 'menu:withdrawal');
  return {
    text: `<b>💳 Выберите верифицированную карту (${cards.length})</b>`,
    keyboard: kb,
  };
}

export function renderWithdrawalSbpBanks(banks: SbpBankMember[]): RenderedView {
  const kb = new InlineKeyboard();
  for (const b of banks.slice(0, 15)) {
    kb.text(`🏦 ${b.name}`, fitCallback('withdraw:set_sbp', b.id)).row();
  }
  kb.text('⬅️ Назад', 'menu:withdrawal');
  return {
    text: `<b>🏦 Выберите банк СБП (${banks.length})</b>`,
    keyboard: kb,
  };
}

export function renderOtherSettings(cfg: BotConfig): RenderedView {
  const p = cfg.playerok;
  const text = [
    '<b>🔧 Прочие настройки</b>',
    '',
    `Водяной знак: ${boolIcon(p.watermark.enabled)} <code>${escapeHtml(p.watermark.value)}</code>`,
    `Помечать чаты прочитанными: ${boolIcon(p.read_chat)}`,
    `Авто-возврат сделок из ЧС: ${boolIcon(p.blacklist.auto_refund)}`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(`${boolIcon(p.watermark.enabled)} Водяной знак`, 'toggle:other:watermark')
    .text('✏️ Текст знака', 'fsm:edit_watermark').row()
    .text(`${boolIcon(p.read_chat)} Чтение чатов`, 'toggle:other:read_chat')
    .text(`${boolIcon(p.blacklist.auto_refund)} Авто-возврат ЧС`, 'toggle:other:bl_refund').row()
    .text('⬅️ В меню', 'menu:main');
  return { text, keyboard: kb };
}

export function renderConnectionSettings(cfg: BotConfig, dryRun: boolean): RenderedView {
  const pl = cfg.playerok.api;
  const tg = cfg.telegram.api;
  const text = [
    '<b>🛜 Соединение и API</b>',
    '',
    `Режим PlayerOK: <b>${dryRun ? 'DRY-RUN (Mock)' : 'GraphQL + WS'}</b>`,
    `Cookies PlayerOK: ${pl.cookies ? '✅ заданы' : '❌ не заданы'}`,
    `User-Agent: <code>${escapeHtml((pl.user_agent || 'по умолчанию').slice(0, 48))}</code>`,
    `Прокси PlayerOK: <code>${pl.proxy ? maskProxy(pl.proxy) : 'нет'}</code>`,
    `Таймаут запросов: <b>${pl.requests_timeout}с</b>`,
    '',
    `Telegram API URL: <code>${escapeHtml(tg.custom_api_url || 'https://api.telegram.org')}</code>`,
    `Прокси Telegram: <code>${tg.proxy ? maskProxy(tg.proxy) : 'нет'}</code>`,
    `Пароль входа (legacy): ${cfg.telegram.bot.password ? '✅ задан' : 'не задан'}`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('🍪 Cookies PlayerOK', 'fsm:conn:pl_cookies')
    .text('🌐 Прокси PlayerOK', 'fsm:conn:pl_proxy').row()
    .text('🖥️ User-Agent', 'fsm:conn:pl_ua')
    .text(`⏱ Таймаут (${pl.requests_timeout}с)`, 'fsm:conn:pl_timeout').row()
    .text('☁️ TG API URL', 'fsm:conn:tg_api_url')
    .text('🌐 Прокси TG', 'fsm:conn:tg_proxy').row()
    .text('🔑 Пароль TG', 'fsm:conn:tg_password')
    .text('🔄 Переподключить', 'action:setup_launch').row()
    .text('⬅️ В меню', 'menu:main');

  return { text, keyboard: kb };
}

export function renderMessagesList(messages: MessagesSettings): RenderedView {
  const kb = new InlineKeyboard();
  for (const [key, tpl] of Object.entries(messages)) {
    kb.text(`${boolIcon(tpl.enabled)} ${tpl.label}`, `msg:view:${key}`).row();
  }
  kb.text('⬅️ В меню', 'menu:main');
  return {
    text: '<b>💬 Шаблоны сообщений на события</b>\n\nВыберите шаблон для настройки:',
    keyboard: kb,
  };
}

export function renderMessageDetail(key: string, tpl: MessageTemplate): RenderedView {
  const text = [
    `<b>${escapeHtml(tpl.label)}</b> (<code>${escapeHtml(key)}</code>)`,
    `Статус: ${boolIcon(tpl.enabled)}`,
    '',
    `<blockquote>${escapeHtml(tpl.text.join('\n') || '(пусто)')}</blockquote>`,
    '',
    '<i>Плейсхолдеры: {user.username}, {item.name}, {item.price}, {deal.id}, {review_rating}</i>',
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(`${boolIcon(tpl.enabled)} Переключить`, `msg:toggle:${key}`)
    .text('✏️ Изменить текст', `fsm:edit_message:${key}`).row()
    .text('⬅️ К сообщениям', 'menu:messages');
  return { text, keyboard: kb };
}

export function renderCommandsList(commands: CustomCommandsSettings): RenderedView {
  const keys = Object.keys(commands);
  const lines = keys.length
    ? keys.map((k) => `• <code>${escapeHtml(k)}</code> → ${escapeHtml(commands[k].join(' / ').slice(0, 60))}`)
    : ['<i>Кастомных команд пока нет.</i>'];
  const kb = new InlineKeyboard().text('➕ Добавить команду', 'fsm:add_command').row();
  for (const k of keys.slice(0, 12)) {
    kb.text(`🗑 ${k}`, fitCallback('cmd:del', k)).row();
  }
  kb.text('⬅️ В меню', 'menu:main');
  return { text: `<b>❗ Кастомные команды (${keys.length})</b>\n\n${lines.join('\n')}`, keyboard: kb };
}

export function renderDeliveriesList(rules: AutoDeliveryRule[], page = 0): RenderedView {
  const { slice, page: safePage, totalPages } = paginate(rules, page);
  const offset = safePage * PAGE_SIZE;

  const lines = slice.length
    ? slice.map((r, idx) => {
        const title = bindingLinks(r);
        const kind = r.piece ? `📦 поштучно (ост: ${r.goods?.length ?? 0})` : '💬 сообщение';
        return `${offset + idx + 1}. ${title} — ${kind}`;
      })
    : ['<i>Правил авто-выдачи пока нет.</i>'];

  const kb = new InlineKeyboard().text('➕ Добавить правило', 'fsm:add_delivery').row();
  slice.forEach((r, idx) => {
    const absIdx = offset + idx;
    kb.text(`⚙️ #${absIdx + 1} ${bindingTitle(r).slice(0, 24)}`, `deliv:view:${absIdx}`).row();
  });
  appendPager(kb, safePage, totalPages, 'deliv:list');
  kb.text('⬅️ В меню', 'menu:main');
  return { text: `<b>🚀 Авто-выдача товаров (${rules.length})</b>\n\n${lines.join('\n')}`, keyboard: kb };
}

export function renderDeliveryDetail(index: number, rule: AutoDeliveryRule): RenderedView {
  const body = rule.piece
    ? `Поштучных товаров: <b>${rule.goods?.length ?? 0}</b>\n${(rule.goods ?? []).slice(0, 5).map((g, i) => `${i + 1}. <code>${escapeHtml(g.slice(0, 48))}</code>`).join('\n') || '<i>Пусто</i>'}`
    : `Текст выдачи:\n<blockquote>${escapeHtml((rule.message ?? []).join('\n') || '(пусто)')}</blockquote>`;

  const text = [
    `<b>🚀 Правило авто-выдачи #${index + 1}</b>`,
    `Привязка: ${bindingLinks(rule)}`,
    `Режим: <b>${rule.piece ? '📦 Поштучная выдача' : '💬 Статичное сообщение'}</b>`,
    '',
    body,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(`🔀 Режим: ${rule.piece ? 'Поштучно' : 'Сообщение'}`, `deliv:toggle_piece:${index}`).row();
  if (rule.piece) {
    kb.text('➕ Добавить товары (текст/.txt)', `fsm:deliv_goods:${index}`)
      .text('🧹 Очистить товары', `deliv:clear_goods:${index}`).row();
  } else {
    kb.text('✏️ Изменить текст выдачи', `fsm:deliv_msg:${index}`).row();
  }
  kb.text('🗑 Удалить правило', `deliv:del:${index}`).row()
    .text('⬅️ К правилам', 'deliv:list:0');
  return { text, keyboard: kb };
}

export function renderDataReplacementList(rules: DataReplacementRule[], page = 0): RenderedView {
  const { slice, page: safePage, totalPages } = paginate(rules, page);
  const offset = safePage * PAGE_SIZE;

  const lines = slice.length
    ? slice.map(
        (r, i) =>
          `${offset + i + 1}. ${boolIcon(r.enabled)} ${bindingLinks(r)} — строк: <b>${r.data.length}</b> (разд: <code>${escapeHtml(r.separator)}</code>)`,
      )
    : ['<i>Правил замены данных пока нет.</i>'];

  const kb = new InlineKeyboard().text('➕ Добавить правило', 'fsm:add_dr').row();
  slice.forEach((r, i) => {
    const absIdx = offset + i;
    kb.text(`⚙️ #${absIdx + 1} ${bindingTitle(r).slice(0, 24)}`, `dr:view:${absIdx}`).row();
  });
  appendPager(kb, safePage, totalPages, 'dr:list');
  kb.text('⬅️ В меню', 'menu:main');
  return { text: `<b>🔄 Замена данных товара (${rules.length})</b>\n\n${lines.join('\n')}`, keyboard: kb };
}

export function renderDataReplacementDetail(index: number, rule: DataReplacementRule): RenderedView {
  const preview = rule.data
    .slice(0, 5)
    .map((line, i) => `${i + 1}. <code>${escapeHtml(line.slice(0, 48))}</code>`)
    .join('\n');

  const text = [
    `<b>🔄 Замена данных #${index + 1}</b>`,
    `Привязка: ${bindingLinks(rule)}`,
    `Статус: ${boolIcon(rule.enabled)} | Разделитель: <code>${escapeHtml(rule.separator)}</code>`,
    `Строк в запасе: <b>${rule.data.length}</b>`,
    '',
    preview || '<i>Данных нет</i>',
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(`${boolIcon(rule.enabled)} Вкл/Выкл`, `dr:toggle:${index}`)
    .text(`✏️ Разд: ${rule.separator}`, `fsm:dr_sep:${index}`).row()
    .text('➕ Добавить строки (текст/.txt)', `fsm:dr_lines:${index}`)
    .text('🧹 Очистить строки', `dr:clear:${index}`).row()
    .text('🗑 Удалить правило', `dr:del:${index}`).row()
    .text('⬅️ К заменам', 'dr:list:0');
  return { text, keyboard: kb };
}

export function renderFastRepliesList(replies: FastReply[]): RenderedView {
  const lines = replies.length
    ? replies.map((r, i) => `${i + 1}. <b>${escapeHtml(r.name)}</b>: ${escapeHtml(r.text.join(' ').slice(0, 50))}`)
    : ['<i>Быстрых ответов пока нет.</i>'];
  const kb = new InlineKeyboard().text('➕ Добавить быстрый ответ', 'fsm:add_fast_reply').row();
  replies.slice(0, 12).forEach((r, idx) => {
    kb.text(`🗑 ${r.name.slice(0, 24)}`, `fr:del:${idx}`).row();
  });
  kb.text('⬅️ В меню', 'menu:main');
  return { text: `<b>⚡ Быстрые ответы (${replies.length})</b>\n\n${lines.join('\n')}`, keyboard: kb };
}

export function renderBlacklist(entries: BlacklistEntryWithUser[], page = 0): RenderedView {
  const { slice, page: safePage, totalPages } = paginate(entries, page);
  const lines = slice.length
    ? slice.map(
        (e) => `• <b>${escapeHtml(e.username)}</b>${e.reason ? ` — ${escapeHtml(e.reason)}` : ''}`,
      )
    : ['<i>Чёрный список пуст.</i>'];
  const kb = new InlineKeyboard().text('➕ Добавить в ЧС', 'fsm:add_blacklist').row();
  for (const e of slice) {
    kb.text(
      `✅ Убрать ${e.username}`,
      fitCallback('bl:del', e.username + ':' + safePage),
    ).row();
  }
  appendPager(kb, safePage, totalPages, 'bl:list');
  kb.text('⬅️ В меню', 'menu:main');
  return { text: `<b>🚫 Чёрный список (${entries.length})</b>\n\n${lines.join('\n')}`, keyboard: kb };
}

export function renderProfile(account: AccountInfo | null): RenderedView {
  if (!account) {
    return {
      text: '<b>👤 Профиль PlayerOK</b>\n\n❌ Аккаунт не подключён.',
      keyboard: new InlineKeyboard().text('⬅️ В меню', 'menu:main'),
    };
  }
  const bal = account.profile.balance;
  const stats = account.profile.stats;
  const text = [
    '<b>👤 Профиль PlayerOK</b>',
    '',
    `Никнейм: <b>${escapeHtml(account.username)}</b>`,
    `ID: <code>${escapeHtml(account.id)}</code>`,
    `Рейтинг: <b>${account.profile.rating ?? '—'}⭐</b> (${account.profile.reviewsCount ?? 0} отзывов)`,
    bal
      ? [
          '',
          `💰 Баланс: <b>${bal.value}₽</b>`,
          `• Доступно: <b>${bal.available}₽</b> (к выводу: <b>${bal.withdrawable}₽</b>)`,
          `• В ожидании: <b>${bal.pendingIncome}₽</b> | Заморожено: <b>${bal.frozen}₽</b>`,
        ].join('\n')
      : '',
    stats
      ? [
          '',
          `📊 Продажи: всего <b>${stats.deals.outgoing.total}</b>, активных <b>${stats.deals.outgoing.total - stats.deals.outgoing.finished}</b>`,
          `🛒 Покупки: всего <b>${stats.deals.incoming.total}</b>, активных <b>${stats.deals.incoming.total - stats.deals.incoming.finished}</b>`,
        ].join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    text,
    keyboard: new InlineKeyboard()
      .text('🔄 Обновить', 'action:refresh_profile').row()
      .text('⬅️ В меню', 'menu:main'),
  };
}

export function renderStats(
  orders: CachedOrders,
  period: StatsPeriod,
  topItems: Array<{ name: string; qty: number; revenue: number }> = [],
): RenderedView {
  const s = computeOrdersStats(orders, period);
  const titles: Record<StatsPeriod, string> = {
    day: 'за 24 часа',
    week: 'за 7 дней',
    month: 'за 30 дней',
    all: 'за всё время',
  };
  const lines = [
    `<b>📊 Статистика продаж (${titles[period]})</b>`,
    '',
    `Всего сделок: <b>${s.totalDeals}</b>`,
    `• Подтверждено: <b>${s.confirmedDeals}</b> (${s.confirmedAmount}₽)`,
    `• В процессе: <b>${s.pendingDeals}</b>`,
    `• Возвратов: <b>${s.refundedDeals}</b> (${s.refundedAmount}₽)`,
    `Общий оборот: <b>${s.grossAmount}₽</b>`,
  ];

  if (topItems.length > 0) {
    lines.push('', '<b>🏆 Топ товаров:</b>');
    topItems.forEach((item, index) => {
      lines.push(
        `${index + 1}. ${escapeHtml(item.name)} — ${item.qty} шт · <b>${item.revenue}₽</b>`,
      );
    });
  }

  const text = lines.join('\n');

  const kb = new InlineKeyboard()
    .text(period === 'day' ? '• 24ч •' : '24ч', 'stats:day')
    .text(period === 'week' ? '• Неделя •' : 'Неделя', 'stats:week')
    .text(period === 'month' ? '• Месяц •' : 'Месяц', 'stats:month')
    .text(period === 'all' ? '• Всё •' : 'Всё', 'stats:all').row()
    .text('⬅️ В меню', 'menu:main');
  return { text, keyboard: kb };
}

export function renderChatsList(chats: Chat[], myId?: string, page = 0): RenderedView {
  const { slice, page: safePage, totalPages } = paginate(chats, page);
  const kb = new InlineKeyboard();
  for (const c of slice) {
    const other = c.users.find((u) => u.id !== myId) ?? c.users[0];
    const unread = c.unreadMessagesCounter ? ` (${c.unreadMessagesCounter})` : '';
    kb.text(`💬 ${other?.username ?? c.id}${unread}`, fitCallback('chat:view', c.id)).row();
  }
  appendPager(kb, safePage, totalPages, 'chats:page');
  kb.text('⬅️ В меню', 'menu:main');
  return {
    text: `<b>💬 Чаты PlayerOK (${chats.length})</b>`,
    keyboard: kb,
  };
}

export function renderChatDetail(
  chat: Chat,
  messages: ChatMessage[],
  fastReplies: FastReply[],
  myId?: string,
): RenderedView {
  const other = chat.users.find((u) => u.id !== myId) ?? chat.users[0];
  const lines = messages.slice(-10).map((m) => {
    const who = m.user.id === myId ? 'Вы' : m.user.username;
    const imgBadge = m.images?.length ? `[📷×${m.images.length}] ` : '';
    return `<b>${escapeHtml(who)}:</b> ${imgBadge}${escapeHtml(m.text ?? '')}`;
  });
  const text = [
    `<b>💬 Чат с ${escapeHtml(other?.username ?? chat.id)}</b>`,
    '',
    ...(lines.length ? lines : ['<i>Сообщений нет</i>']),
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('✏️ Написать / отправить фото', fitCallback('chat:reply', chat.id)).row();
  fastReplies.slice(0, 4).forEach((fr, idx) => {
    // chat id + reply index travel together: both are needed to send the right reply
    kb.text(`⚡ ${fr.name.slice(0, 18)}`, fitCallback('chat:fr', chat.id + ':' + idx)).row();
  });
  kb.text('🔄 Обновить', fitCallback('chat:view', chat.id)).text('⬅️ К чатам', 'chats:page:0');
  return { text, keyboard: kb };
}

export function renderDealsList(deals: ItemDeal[], filter = 'ALL', page = 0): RenderedView {
  const { slice, page: safePage, totalPages } = paginate(deals, page);
  const kb = new InlineKeyboard()
    .text(filter === 'ALL' ? '• Все •' : 'Все', 'deals:ALL:0')
    .text(filter === ItemDealStatuses.PAID ? '• PAID •' : 'PAID', `deals:${ItemDealStatuses.PAID}:0`)
    .text(filter === ItemDealStatuses.SENT ? '• SENT •' : 'SENT', `deals:${ItemDealStatuses.SENT}:0`)
    .text(filter === ItemDealStatuses.CONFIRMED ? '• OK •' : 'OK', `deals:${ItemDealStatuses.CONFIRMED}:0`)
    .row();

  for (const d of slice) {
    kb.text(`📋 ${d.user.username} · ${d.item.price}₽ (${d.status})`, fitCallback('deal:view', d.id)).row();
  }
  appendPager(kb, safePage, totalPages, `deals:${filter}`);
  kb.text('⬅️ В меню', 'menu:main');
  return { text: `<b>📋 Сделки [${filter}] (${deals.length})</b>`, keyboard: kb };
}

export function renderDealDetail(deal: ItemDeal): RenderedView {
  const text = [
    `<b>📋 Сделка <code>${escapeHtml(deal.id)}</code></b>`,
    '',
    `Статус: <b>${deal.status}</b>`,
    `Покупатель: <b>${escapeHtml(deal.user.username)}</b>`,
    `Товар: <b>${escapeHtml(deal.item.name)}</b>`,
    `Сумма: <b>${deal.item.price}₽</b>`,
  ].join('\n');
  const kb = new InlineKeyboard()
    .text('✅ Подтвердить (SENT)', fitCallback('deal:confirm', deal.id))
    .text('📦 Возврат', fitCallback('deal:refund', deal.id)).row()
    .text('⬅️ К сделкам', 'deals:ALL:0');
  return { text, keyboard: kb };
}

export function renderItemsList(items: ItemProfile[], filter = 'APPROVED', page = 0): RenderedView {
  const { slice, page: safePage, totalPages } = paginate(items, page);
  const kb = new InlineKeyboard()
    .text(filter === ItemStatuses.APPROVED ? '• Актив •' : 'Актив', `items:${ItemStatuses.APPROVED}:0`)
    .text(filter === ItemStatuses.SOLD ? '• Продан •' : 'Продан', `items:${ItemStatuses.SOLD}:0`)
    .text(filter === ItemStatuses.EXPIRED ? '• Истёк •' : 'Истёк', `items:${ItemStatuses.EXPIRED}:0`)
    .text(filter === ItemStatuses.DRAFT ? '• Черн •' : 'Черн', `items:${ItemStatuses.DRAFT}:0`)
    .row();

  for (const it of slice) {
    kb.text(`🛍️ ${it.name.slice(0, 26)} · ${it.price}₽`, fitCallback('item:view', it.id)).row();
  }
  appendPager(kb, safePage, totalPages, `items:${filter}`);
  kb.text('⬅️ В меню', 'menu:main');
  return { text: `<b>🛍️ Товары [${filter}] (${items.length})</b>`, keyboard: kb };
}

export function renderItemDetail(item: ItemProfile): RenderedView {
  const text = [
    `<b>🛍️ ${escapeHtml(item.name)}</b>`,
    '',
    `ID: <code>${escapeHtml(item.id)}</code>`,
    `Цена: <b>${item.price}₽</b> (чистыми: ${item.rawPrice}₽)`,
    `Статус: <b>${item.status ?? '—'}</b> | Приоритет: <b>${item.priority ?? '—'}</b>`,
    `Позиция: <b>${item.sequence ?? '—'}</b>`,
  ].join('\n');
  const kb = new InlineKeyboard()
    .text('⬆️ Поднять', fitCallback('item:bump', item.id))
    .text('♻️ Восстановить', fitCallback('item:restore', item.id)).row()
    .text('⬅️ К товарам', 'items:APPROVED:0');
  return { text, keyboard: kb };
}

export function renderTransactionsList(txs: Transaction[], page = 0): RenderedView {
  const { slice, page: safePage, totalPages } = paginate(txs, page);
  const lines = slice.map(
    (t) => `• <b>${t.value}₽</b> (${t.operation} · ${t.status}) — <code>${t.createdAt.slice(0, 10)}</code>`,
  );
  const kb = new InlineKeyboard();
  appendPager(kb, safePage, totalPages, 'txs:page');
  kb.text('⬅️ В меню', 'menu:main');
  return {
    text: `<b>💳 Транзакции (${txs.length})</b>\n\n${lines.join('\n') || '<i>Пусто</i>'}`,
    keyboard: kb,
  };
}

export function renderReviewsList(reviews: Review[], ratingFilter = 0, page = 0): RenderedView {
  const { slice, page: safePage, totalPages } = paginate(reviews, page);
  const lines = slice.map(
    (r) => `• ${'⭐'.repeat(r.rating)} <b>${escapeHtml(r.creator.username)}</b>: ${escapeHtml(r.text || 'без текста')}`,
  );
  const kb = new InlineKeyboard()
    .text(ratingFilter === 0 ? '• Все •' : 'Все', 'reviews:0:0')
    .text(ratingFilter === 5 ? '• 5⭐ •' : '5⭐', 'reviews:5:0')
    .text(ratingFilter === 4 ? '• 4⭐ •' : '4⭐', 'reviews:4:0')
    .text(ratingFilter === 1 ? '• 1⭐ •' : '1⭐', 'reviews:1:0')
    .row();
  appendPager(kb, safePage, totalPages, `reviews:${ratingFilter}`);
  kb.text('⬅️ В меню', 'menu:main');
  return {
    text: `<b>🌟 Отзывы (${reviews.length})</b>\n\n${lines.join('\n') || '<i>Отзывов нет</i>'}`,
    keyboard: kb,
  };
}

export function renderModulesList(plugins: LoadedPluginRecord[]): RenderedView {
  const kb = new InlineKeyboard()
    .text('➕ Установить плагин (.mjs/.js)', 'fsm:upload_plugin').row();

  const lines = plugins.length
    ? plugins.map((p) => {
        const icon = p.error ? '❌' : p.enabled ? '🟢' : '⚪';
        return `${icon} <b>${escapeHtml(p.meta.name)}</b> v${escapeHtml(p.meta.version)}${p.error ? ` — ${escapeHtml(p.error)}` : ''}`;
      })
    : ['<i>Внешние плагины не установлены. Отправьте .mjs/.js файл или положите его в plugins/.</i>'];

  for (const p of plugins) {
    kb.text(`${p.enabled ? '🔴 Выкл' : '🟢 Вкл'} ${p.meta.name}`, fitCallback('mod:toggle', p.id))
      .text('🗑', fitCallback('mod:del', p.id))
      .row();
  }
  kb.text('⬅️ В меню', 'menu:main');
  return {
    text: `<b>🔌 Плагины Cordis (${plugins.length})</b>\n\n${lines.join('\n')}`,
    keyboard: kb,
  };
}

export function renderUpdatesMenu(cfg: BotConfig, latest: GitHubRelease | null, hasUpdate: boolean): RenderedView {
  const u = cfg.updates;
  const text = [
    '<b>🔃 Обновления</b>',
    '',
    `Текущая версия: <b>v${VERSION}</b>`,
    `Последний релиз GitHub: <b>${latest ? escapeHtml(latest.tagName) : 'не проверялся'}</b>${hasUpdate ? ' 🆕' : ''}`,
    `Уведомления о релизах: ${boolIcon(u.notify)} | Авто-обновление: ${boolIcon(u.auto_update)}`,
    ...(latest?.body ? ['', `<blockquote>${escapeHtml(latest.body.slice(0, 600))}</blockquote>`] : []),
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(`${boolIcon(u.notify)} Уведомлять`, 'toggle:updates:notify')
    .text(`${boolIcon(u.auto_update)} Авто-обновление`, 'toggle:updates:auto_update').row()
    .text('🔄 Проверить релизы', 'action:check_updates').row();
  if (latest?.htmlUrl) {
    kb.url('🌐 Открыть релиз на GitHub', latest.htmlUrl).row();
  }
  kb.text('⬅️ В меню', 'menu:main');
  return { text, keyboard: kb };
}

export function renderLogs(lines: string[]): RenderedView {
  const snippet = lines.slice(-25).join('\n') || 'Логи пусты';
  const trimmed = snippet.length > 3500 ? snippet.slice(-3500) : snippet;
  return {
    text: `<b>🗒️ Последние логи</b>\n\n<pre>${escapeHtml(trimmed)}</pre>`,
    keyboard: new InlineKeyboard()
      .text('🔄 Обновить', 'menu:logs')
      .text('🧹 Очистить', 'logs:clear').row()
      .text('⬅️ В меню', 'menu:main'),
  };
}

export function renderSignedUsers(userIds: number[]): RenderedView {
  const lines = userIds.length
    ? userIds.map((id) => `• <code>${id}</code>`)
    : ['<i>Нет авторизованных пользователей.</i>'];
  const kb = new InlineKeyboard();
  for (const id of userIds) {
    kb.text(`❌ Удалить ${id}`, `auth:revoke:${id}`).row();
  }
  kb.text('⬅️ В меню', 'menu:main');
  return {
    text: `<b>🔑 Авторизованные пользователи (${userIds.length})</b>\n\n${lines.join('\n')}`,
    keyboard: kb,
  };
}

export function renderConfigsMenu(baseDir: string): RenderedView {
  return {
    text: `<b>🗂 Конфигурация и данные</b>\n\nКаталог хранения: <code>${escapeHtml(baseDir)}</code>`,
    keyboard: new InlineKeyboard()
      .text('📤 Выгрузить снимок конфига', 'cfg:export').row()
      .text('⬅️ В меню', 'menu:main'),
  };
}

export function renderRetryQueue(tasks: RetryTask[]): RenderedView {
  const pending = tasks.filter((t) => t.status === 'pending');
  const dead = tasks.filter((t) => t.status === 'dead');
  // A leased task is 'processing': it must be counted, otherwise the queue looks empty
  // exactly while the bot is busy retrying.
  const processing = tasks.filter((t) => t.status === 'processing');

  const lines: string[] = [
    '<b>🔁 Очередь повторов и Dead-Letter Queue</b>',
    '',
    `В ожидании (pending): <b>${pending.length}</b>${processing.length > 0 ? ` | выполняется: <b>${processing.length}</b>` : ''} | Dead-Letter (DLQ): <b>${dead.length}</b>`,
  ];

  if (tasks.length === 0) {
    lines.push('', '<i>Очередь пуста — сбоев API нет.</i>');
  } else {
    lines.push('');
    for (const task of tasks.slice(0, 10)) {
      const icon = task.status === 'dead' ? '☠️' : task.status === 'processing' ? '⚙️' : '⏳';
      const errPreview = task.lastError ? ` — ${escapeHtml(task.lastError.slice(0, 70))}` : '';
      lines.push(
        `${icon} <code>${escapeHtml(task.id)}</code> · <b>${escapeHtml(task.kind)}</b> (${task.attempts}/${task.maxAttempts})${errPreview}`,
      );
    }
    if (tasks.length > 10) {
      lines.push(`<i>…и ещё ${tasks.length - 10} задач(и)</i>`);
    }
  }

  const kb = new InlineKeyboard()
    .text('▶️ Обработать сейчас', 'rq:run')
    .text('🔄 Обновить', 'menu:retry_queue').row();

  if (dead.length > 0) {
    kb.text(`♻️ Повторить все DLQ (${dead.length})`, 'rq:retry_dead')
      .text('🧹 Очистить DLQ', 'rq:clear_dead').row();
  }

  for (const task of tasks.slice(0, 6)) {
    if (task.status === 'dead') {
      kb.text(`♻️ ${task.id}`, fitCallback('rq:retry', task.id))
        .text(`🗑 ${task.id}`, fitCallback('rq:del', task.id)).row();
    } else {
      kb.text(`🗑 Удалить ${task.id}`, fitCallback('rq:del', task.id)).row();
    }
  }

  kb.text('⬅️ В меню', 'menu:main');
  return { text: lines.join('\n'), keyboard: kb };
}
