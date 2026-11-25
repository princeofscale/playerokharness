import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessService,
  BlacklistService,
  Context,
  DEFAULT_CONFIG,
  ItemDealStatuses,
  ItemStatuses,
  PluginManagerService,
  StorageService,
} from '@pkh/core';
import {
  Composer,
  InputStateStore,
  paginate,
  renderBindingsList,
  renderConnectionSettings,
  renderDataReplacementDetail,
  renderDealsList,
  renderDeliveryDetail,
  renderItemsList,
  renderMainMenu,
  renderModulesList,
  renderNotificationsSettings,
  renderReviewsList,
  renderSetupMode,
  renderStats,
  renderUpdatesMenu,
  renderWithdrawalCards,
  renderWithdrawalSbpBanks,
  TelegramService,
  toGrammyKeyboard,
} from '@pkh/plugin-telegram';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-test-tg-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('@pkh/plugin-telegram', () => {
  it('renders main menu, setup mode, pagination, filters, bindings, delivery, data_replacement, withdrawal, updates', () => {
    const main = renderMainMenu(true);
    expect(main.text).toContain('PlayerOK Harness');
    expect(main.text).toContain('DRY-RUN');
    expect(main.keyboard.inline_keyboard.length).toBeGreaterThan(10);

    const setup = renderSetupMode({ code: 'missing_cookies', text: 'Нужны куки', transient: false });
    expect(setup.text).toContain('Режим настройки');
    expect(setup.text).toContain('Нужны куки');

    const paged = paginate([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1, 8);
    expect(paged.slice).toEqual([9, 10]);
    expect(paged.totalPages).toBe(2);

    const notif = renderNotificationsSettings(DEFAULT_CONFIG);
    expect(notif.text).toContain('Настройки уведомлений');

    const conn = renderConnectionSettings(DEFAULT_CONFIG, false);
    expect(conn.text).toContain('Соединение и API');

    const bindings = renderBindingsList(
      'auto_bump_items',
      'included',
      [{ keyphrases: ['Steam'] }],
      0,
    );
    expect(bindings.text).toContain('Steam');

    const deliv = renderDeliveryDetail(0, { keyphrases: ['Key'], piece: true, goods: ['A1', 'A2'] });
    expect(deliv.text).toContain('Поштучных товаров: <b>2</b>');

    const dr = renderDataReplacementDetail(0, {
      keyphrases: ['Account'],
      enabled: true,
      separator: ':',
      data: ['u1:p1'],
    });
    expect(dr.text).toContain('Строк в запасе: <b>1</b>');

    const cards = renderWithdrawalCards([
      { id: 'c1', cardFirstSix: '220070', cardLastFour: '1234', cardType: 'MIR' },
    ]);
    expect(cards.text).toContain('верифицированную карту');

    const banks = renderWithdrawalSbpBanks([{ id: 'b1', name: 'Сбербанк' }]);
    expect(banks.text).toContain('банк СБП');

    const dealsView = renderDealsList([], ItemDealStatuses.PAID, 0);
    expect(dealsView.text).toContain('[PAID]');

    const itemsView = renderItemsList([], ItemStatuses.SOLD, 0);
    expect(itemsView.text).toContain('[SOLD]');

    const reviewsView = renderReviewsList([], 5, 0);
    expect(reviewsView.text).toContain('Отзывы');

    const updatesView = renderUpdatesMenu(
      DEFAULT_CONFIG,
      { tagName: 'v2.1.0', name: 'v2.1.0', body: 'Changelog', htmlUrl: 'https://github.com/test', publishedAt: '' },
      true,
    );
    expect(updatesView.text).toContain('v2.1.0');

    const stats = renderStats(
      {
        d1: {
          id: 'd1',
          price: 1000,
          status: ItemDealStatuses.CONFIRMED,
          date: new Date().toISOString(),
          item_id: 'i1',
          item_name: 'Item',
        },
      },
      'day',
    );
    expect(stats.text).toContain('1000₽');

    const statsWithTop = renderStats({}, 'week', [
      { name: 'Steam <Key>', qty: 2, revenue: 1500 },
    ]);
    expect(statsWithTop.text).toContain('Топ товаров');
    expect(statsWithTop.text).toContain('Steam &lt;Key&gt;');
    expect(statsWithTop.text).toContain('2 шт');
    // Without analytics the section is omitted entirely.
    expect(renderStats({}, 'week').text).not.toContain('Топ товаров');

    const mods = renderModulesList([
      {
        id: 'demo',
        meta: { id: 'demo', name: 'Demo', version: '1.2.3' },
        enabled: true,
        sourcePath: 'plugins/demo.mjs',
      },
    ]);
    expect(mods.text).toContain('Demo');

    const kb = toGrammyKeyboard([
      [{ text: 'Open', url: 'https://playerok.com' }, { text: 'Reply', callbackData: 'chat:reply:1' }],
    ]);
    expect(kb?.inline_keyboard[0]).toHaveLength(2);
  });

  it('manages per-user FSM input state and external composer registration', async () => {
    const fsm = new InputStateStore();
    fsm.set(123, { kind: 'reply_chat', chatId: 'c1' });
    expect(fsm.get(123)).toEqual({ kind: 'reply_chat', chatId: 'c1' });
    fsm.clear(123);
    expect(fsm.get(123)).toBeUndefined();

    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(AccessService);
    await ctx.use(BlacklistService);
    await ctx.use(PluginManagerService);
    await ctx.use(TelegramService, { token: '' });

    const composer = new Composer();
    const dispose = ctx.telegram.addComposer(composer);
    expect(typeof dispose).toBe('function');
    dispose();

    await ctx.fiber.dispose();
  });
});
