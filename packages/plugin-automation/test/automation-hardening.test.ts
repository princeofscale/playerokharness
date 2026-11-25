import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BlacklistService,
  Context,
  EventTypes,
  ItemStatuses,
  StorageService,
} from '@pkh/core';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import { RetryQueueService } from '@pkh/plugin-retry-queue';
import { mountAutomation } from '@pkh/plugin-automation';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-auto-harden-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SEED_ITEM_ID = '11111111-1111-1111-1111-111111111111';

interface Booted {
  ctx: Context;
  mock: MockPlayerokTransport;
}

/**
 * Boots the automation stack on a bare Context: storage + blacklist + playerok + retry queue,
 * then the real automation bundle, with every timer disabled for determinism.
 */
async function boot(): Promise<Booted> {
  const mock = new MockPlayerokTransport();
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: makeTempDir() });
  await ctx.use(BlacklistService);
  await ctx.use(PlayerokService, { dryRun: true, enableMaintenanceLoops: false, transport: mock });
  await ctx.use(RetryQueueService, { enableTimer: false });
  mountAutomation(ctx, { enableTimers: false });
  // PlayerOK events only reach the plugins once the service subscribes to the transport.
  await ctx.playerok.connect();
  await ctx.playerok.startListening();
  return { ctx, mock };
}

describe('@pkh/plugin-automation: buyer commands & failure isolation', () => {
  it('runs a custom command that is the buyer very first message', async () => {
    const { ctx, mock } = await boot();
    ctx.storage.set('custom_commands', { '!инфо': ['Инфо: {user.username}'] });

    await mock.simulateNewMessage('chat-cmd', { id: 'buyer-cmd', username: 'CmdBuyer' }, '!инфо');

    const texts = mock.sentMessages.map((m) => m.text ?? '');
    // Before the fix the welcome text replaced the command answer: the first message was
    // consumed by the greeting branch, so a documented command silently never matched.
    expect(texts.some((text) => text.includes('Инфо: CmdBuyer'))).toBe(true);
    expect(texts.some((text) => text.includes('бот-помощник'))).toBe(false);

    await ctx.fiber.dispose();
  });

  it('still greets a brand-new buyer whose first message is plain text', async () => {
    const { ctx, mock } = await boot();

    await mock.simulateNewMessage('chat-plain', { id: 'buyer-plain', username: 'PlainBuyer' }, 'привет');

    expect(mock.sentMessages.some((m) => (m.text ?? '').includes('PlainBuyer'))).toBe(true);

    await ctx.fiber.dispose();
  });

  it('keeps bumping the remaining items when the failure notification cannot be delivered', async () => {
    const { ctx, mock } = await boot();
    const template = mock.items.get(SEED_ITEM_ID)!;
    for (const id of ['22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333']) {
      mock.items.set(id, { ...structuredClone(template), id, name: `Copy ${id}`, slug: `copy-${id}` });
    }
    ctx.storage.updateConfig((cfg) => {
      cfg.playerok.auto_bump_items.all = true;
    });

    const attempts: string[] = [];
    mock.increaseItemPriorityStatus = async (itemId: string) => {
      attempts.push(itemId);
      throw new Error('premium charge failed');
    };
    // A dead Telegram session rejects every notification.
    ctx.on('notify/log', () => {
      throw new Error('telegram session is dead');
    });

    // Before the fix the first notification threw out of bumpItem(), so bumpItems() rejected
    // and the two remaining items were never even attempted.
    const result = await ctx.autoBump.bumpItems();

    expect(attempts).toHaveLength(3);
    expect(result).toEqual({ total: 3, bumped: 0 });

    await ctx.fiber.dispose();
  });

  it('reports a withdrawal failure instead of throwing when the notification cannot be delivered', async () => {
    const { ctx } = await boot();
    ctx.on('notify/log', () => {
      throw new Error('telegram session is dead');
    });

    // No credentials configured: the request fails, and reporting it must not throw.
    const result = await ctx.autoWithdrawal.requestWithdrawal();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('способ вывода');

    await ctx.fiber.dispose();
  });

  it('does not report a completed withdrawal as failed when the announcement listener throws', async () => {
    const { ctx, mock } = await boot();
    ctx.storage.updateConfig((cfg) => {
      cfg.playerok.auto_withdrawal.credentials_type = 'usdt';
      cfg.playerok.auto_withdrawal.usdt_address = 'TTestUsdtAddress12345';
    });
    ctx.on('withdrawal/requested', () => {
      throw new Error('dashboard broadcast failed');
    });

    const result = await ctx.autoWithdrawal.requestWithdrawal();

    // The transaction WAS created. Before the fix the announcement throw ran the catch below
    // it, so the operator was told the withdrawal failed (and got an error notification)
    // while the money was already on its way.
    expect(result.ok).toBe(true);
    expect(result.amount).toBe(3200);
    expect(mock.withdrawalRequests).toHaveLength(1);

    await ctx.fiber.dispose();
  });

  it('does not report a completed bump as failed when the announcement listener throws', async () => {
    const { ctx, mock } = await boot();
    ctx.storage.updateConfig((cfg) => {
      cfg.playerok.auto_bump_items.all = true;
    });
    ctx.on('item/bumped', () => {
      throw new Error('dashboard broadcast failed');
    });

    const ok = await ctx.autoBump.bumpItem(await mock.getItem({ id: SEED_ITEM_ID }), 'test');

    // The premium bump was charged and applied, so it must not be reported as an error
    // (which also queued a retry that would charge the premium a second time).
    expect(ok).toBe(true);
    expect(mock.bumpedItemIds).toContain(SEED_ITEM_ID);

    await ctx.fiber.dispose();
  });

  it('does not report a completed restore as failed when the announcement listener throws', async () => {
    const { ctx, mock } = await boot();
    ctx.storage.updateConfig((cfg) => {
      cfg.playerok.auto_restore_items.all = true;
    });
    ctx.on('item/restored', () => {
      throw new Error('dashboard broadcast failed');
    });

    const ok = await ctx.autoRestore.restoreItem(await mock.getItem({ id: SEED_ITEM_ID }));

    expect(ok).toBe(true);
    expect(mock.publishedItems).toHaveLength(1);

    await ctx.fiber.dispose();
  });

  it('does not re-scan the SOLD page for an item that is already restored', async () => {
    const { ctx, mock } = await boot();
    ctx.storage.updateConfig((cfg) => {
      cfg.playerok.auto_restore_items.sold = true;
      cfg.playerok.auto_restore_items.all = true;
    });

    let soldPageScans = 0;
    const originalGetMyItems = mock.getMyItems.bind(mock);
    mock.getMyItems = async (params = {}) => {
      if ((params.statuses ?? []).includes(ItemStatuses.SOLD)) soldPageScans += 1;
      return originalGetMyItems(params);
    };

    const deal = await mock.simulateNewDeal({
      buyer: { id: 'buyer-restore', username: 'RestoreBuyer' },
      chatId: 'chat-restore',
      itemId: SEED_ITEM_ID,
    });

    // The item id resolves, so the sold listing is restored without any page scan.
    expect(soldPageScans).toBe(0);
    expect(mock.publishedItems).toHaveLength(1);
    expect((await mock.getItem({ id: SEED_ITEM_ID })).status).toBe(ItemStatuses.APPROVED);

    // A replayed ITEM_PAID event (WS reconnect / catch-up) must be a no-op. Before the fix the
    // "already restored" answer fell through to the SOLD page, whose fallback matches by name
    // and could publish a different listing that happens to share the name.
    const chat = await mock.getChat('chat-restore');
    await mock.emitEvent({ type: EventTypes.ITEM_PAID, chat, deal, timestamp: Date.now() });

    expect(soldPageScans).toBe(0);
    expect(mock.publishedItems).toHaveLength(1);

    await ctx.fiber.dispose();
  });
});
