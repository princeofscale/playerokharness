import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EventTypes,
  GameCategoryDataFieldTypes,
  ItemDealStatuses,
  ItemStatuses,
  PriorityTypes,
  type NotificationPayload,
  type SellerCallPayload,
} from '@playerok/core';
import { MockPlayerokTransport } from '@playerok/adapter';
import { computeOrdersStats } from '@playerok/plugin-automation';
import { createApplication } from '@playerok/app';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playerok-v2-auto-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('End-to-end automation plugins on Cordis 4', () => {
  it('handles first_message, !продавец, custom commands, auto-delivery (piece), auto-complete, orders cache, and notifications', async () => {
    const dir = makeTempDir();
    const mock = new MockPlayerokTransport();
    const app = await createApplication({
      dataDir: dir,
      dryRun: true,
      transport: mock,
      enableTelegram: false,
      enableTimers: false,
      enableInstanceLock: false,
      silentConsole: true,
    });

    const notifications: NotificationPayload[] = [];
    const sellerCalls: SellerCallPayload[] = [];
    app.ctx.on('notify/log', (p) => {
      notifications.push(p);
    });
    app.ctx.on('notify/call-seller', (p) => {
      sellerCalls.push(p);
    });

    app.ctx.storage.updateConfig((cfg) => {
      cfg.playerok.auto_complete_deals.enabled = true;
      cfg.playerok.auto_complete_deals.all = true;
      cfg.playerok.auto_restore_items.sold = true;
    });
    app.ctx.storage.set('custom_commands', {
      '!инфо': ['Магазин работает 24/7, {user.username}!'],
    });
    app.ctx.storage.set('auto_deliveries', [
      {
        keyphrases: ['Steam Key'],
        piece: true,
        goods: ['KEY-001', 'KEY-002'],
      },
    ]);
    app.ctx.storage.set('data_replacement', [
      {
        keyphrases: ['Steam Key'],
        enabled: true,
        separator: ':',
        data: ['new_login_1:new_pass_1', 'new_login_2:new_pass_2'],
      },
    ]);

    await app.start();

    const buyer = { id: 'buyer-42', username: 'IvanBuyer' };

    // 1. First message triggers greeting
    await mock.simulateNewMessage('chat-42', buyer, 'Привет!');
    expect(mock.sentMessages.some((m) => m.text?.includes('Привет, IvanBuyer'))).toBe(true);

    // 2. !продавец triggers seller call & confirmation reply
    await mock.simulateNewMessage('chat-42', buyer, '!продавец');
    expect(sellerCalls).toHaveLength(1);
    expect(sellerCalls[0]).toEqual({ username: 'IvanBuyer', chatId: 'chat-42' });

    // 3. Custom command triggers interpolated response
    await mock.simulateNewMessage('chat-42', buyer, '!инфо');
    expect(mock.sentMessages.some((m) => m.text?.includes('Магазин работает 24/7, IvanBuyer!'))).toBe(true);

    // 4. New deal triggers piece delivery, auto-complete, orders cache, and SOLD auto-restore + data replacement
    const deal = await mock.simulateNewDeal({
      buyer,
      chatId: 'chat-42',
      itemId: '11111111-1111-1111-1111-111111111111',
    });

    // Piece auto-delivery sent KEY-001 and consumed it
    expect(mock.sentMessages.some((m) => m.text?.includes('KEY-001'))).toBe(true);
    expect(app.ctx.storage.getAutoDeliveries()[0].goods).toEqual(['KEY-002']);

    // Auto-complete marked deal as SENT
    expect(mock.updatedDeals).toContainEqual({ dealId: deal.id, status: ItemDealStatuses.SENT });

    // Auto-restore republished sold item AND replaced & consumed 1 line of data_replacement
    expect(mock.publishedItems.some((p) => p.itemId === '11111111-1111-1111-1111-111111111111')).toBe(true);
    expect(app.ctx.storage.getDataReplacement()[0].data).toEqual(['new_login_2:new_pass_2']);
    const updatedItem = await mock.getItem({ id: '11111111-1111-1111-1111-111111111111' });
    expect(updatedItem.dataFields?.map((f) => f.value)).toEqual(['new_login_1', 'new_pass_1']);

    // Orders cached & stats computed
    const stats = computeOrdersStats(app.ctx.storage.getCachedOrders(), 'day');
    expect(stats.totalDeals).toBe(1);
    expect(stats.grossAmount).toBe(500);

    // Notifications emitted
    expect(notifications.some((n) => n.eventKey === 'new_deal')).toBe(true);
    expect(notifications.some((n) => n.eventKey === 'item_restored')).toBe(true);

    await app.stop();
  });

  it('blocks blacklisted buyer from auto-delivery and auto-refunds when configured', async () => {
    const dir = makeTempDir();
    const mock = new MockPlayerokTransport();
    const app = await createApplication({
      dataDir: dir,
      dryRun: true,
      transport: mock,
      enableTelegram: false,
      enableTimers: false,
      enableInstanceLock: false,
      silentConsole: true,
    });

    app.ctx.blacklist.add('Scammer99', 'мошенник');
    app.ctx.storage.updateConfig((cfg) => {
      cfg.playerok.blacklist.auto_refund = true;
      cfg.playerok.auto_complete_deals.enabled = true;
    });
    app.ctx.storage.set('auto_deliveries', [
      { keyphrases: ['Steam Key'], piece: true, goods: ['SECRET-KEY'] },
    ]);

    await app.start();

    const deal = await mock.simulateNewDeal({
      buyer: { id: 'scam-1', username: 'scammer99' },
      chatId: 'chat-scam',
      itemId: '11111111-1111-1111-1111-111111111111',
    });

    expect(mock.updatedDeals).toContainEqual({ dealId: deal.id, status: ItemDealStatuses.ROLLED_BACK });
    // Secret key was NOT delivered!
    expect(mock.sentMessages.some((m) => m.text?.includes('SECRET-KEY'))).toBe(false);
    expect(app.ctx.storage.getAutoDeliveries()[0].goods).toEqual(['SECRET-KEY']);
    // Refund explanation message was sent
    expect(mock.sentMessages.some((m) => m.text?.includes('чёрном списке'))).toBe(true);

    await app.stop();
  });

  it('recreates non-republishable item, rebinds settings to new ID, and deletes old item', async () => {
    const dir = makeTempDir();
    const oldId = '33333333-3333-3333-3333-333333333333';
    const mock = new MockPlayerokTransport({
      items: [
        {
          id: oldId,
          slug: 'account-item',
          name: 'Account Rare',
          price: 1200,
          rawPrice: 1100,
          priority: PriorityTypes.DEFAULT,
          status: ItemStatuses.SOLD,
          mayBePublished: false,
          category: { id: 'cat-acc' },
          obtainingType: { id: 'obt-acc' },
          dataFields: [
            { id: 'f1', type: GameCategoryDataFieldTypes.ITEM_DATA, value: 'old_acc' },
          ],
          attachments: [],
        },
      ],
    });

    const app = await createApplication({
      dataDir: dir,
      dryRun: true,
      transport: mock,
      enableTelegram: false,
      enableTimers: false,
      enableInstanceLock: false,
      silentConsole: true,
    });

    app.ctx.storage.updateConfig((cfg) => {
      cfg.playerok.auto_restore_items.recreate = true;
      cfg.playerok.auto_restore_items.all = false;
    });
    app.ctx.storage.set('auto_restore_items', {
      included: [{ items: [{ id: oldId, slug: 'account-item', name: 'Account Rare' }] }],
      excluded: [],
    });

    await app.start();

    const ok = await app.ctx.autoRestore.restoreItem(await mock.getItem({ id: oldId }));
    expect(ok).toBe(true);
    expect(mock.removedItemIds).toContain(oldId);
    const newBoundId = (
      app.ctx.storage.getAutoRestoreItems().included[0] as { items: Array<{ id: string }> }
    ).items[0].id;
    expect(newBoundId).not.toBe(oldId);

    await app.stop();
  });

  it('auto-bumps only after streak >= 2 in position mode and respects withdrawal threshold', async () => {
    const dir = makeTempDir();
    const mock = new MockPlayerokTransport();
    const item = mock.items.get('11111111-1111-1111-1111-111111111111')!;
    item.sequence = 15; // dropped below threshold 10

    const app = await createApplication({
      dataDir: dir,
      dryRun: true,
      transport: mock,
      enableTelegram: false,
      enableTimers: false,
      enableInstanceLock: false,
      silentConsole: true,
    });

    app.ctx.storage.updateConfig((cfg) => {
      cfg.playerok.auto_bump_items.enabled = true;
      cfg.playerok.auto_bump_items.mode = 'position';
      cfg.playerok.auto_bump_items.position = 10;
      cfg.playerok.auto_bump_items.all = true;
      cfg.playerok.auto_withdrawal.enabled = true;
      cfg.playerok.auto_withdrawal.credentials_type = 'usdt';
      cfg.playerok.auto_withdrawal.usdt_address = 'TTestUsdtAddress12345';
    });

    await app.start();

    // First check: streak = 1 -> no bump yet
    const r1 = await app.ctx.autoBump.checkItemsPositions(new Date('2026-11-24T12:00:00Z'));
    expect(r1.bumped).toBe(0);
    expect(mock.bumpedItemIds).toHaveLength(0);

    // Second check: streak = 2 -> bumped!
    const r2 = await app.ctx.autoBump.checkItemsPositions(new Date('2026-11-24T12:05:00Z'));
    expect(r2.bumped).toBe(1);
    expect(mock.bumpedItemIds).toContain('11111111-1111-1111-1111-111111111111');

    // Withdrawal succeeds when balance > 500
    const w1 = await app.ctx.autoWithdrawal.requestWithdrawal();
    expect(w1.ok).toBe(true);
    expect(w1.amount).toBe(3200);
    expect(mock.withdrawalRequests).toHaveLength(1);

    // Second withdrawal fails cleanly because balance is now 0
    const w2 = await app.ctx.autoWithdrawal.requestWithdrawal();
    expect(w2.ok).toBe(false);

    // Review event emits notification
    const reviewNotifs: NotificationPayload[] = [];
    app.ctx.on('notify/log', (n) => {
      if (n.eventKey === 'new_review') reviewNotifs.push(n);
    });
    const chat = await mock.getChat('chat-demo-1');
    await mock.emitEvent({
      type: EventTypes.NEW_REVIEW,
      chat,
      timestamp: Date.now(),
      deal: {
        id: 'deal-rev-1',
        status: ItemDealStatuses.CONFIRMED,
        user: { id: 'buyer-001', username: 'DemoBuyer' },
        item,
        review: {
          id: 'rev-99',
          rating: 5,
          text: 'Отличный продавец!',
          createdAt: new Date().toISOString(),
          creator: { id: 'buyer-001', username: 'DemoBuyer' },
        },
      },
    });
    expect(reviewNotifs).toHaveLength(1);

    await app.stop();
  });
});
