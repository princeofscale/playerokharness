import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BlacklistService, Context, StorageService } from '@pkh/core';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import { RetryQueueService } from '@pkh/plugin-retry-queue';
import { mountAutomation } from '@pkh/plugin-automation';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-stock-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const STEAM_ITEM_ID = '11111111-1111-1111-1111-111111111111'; // 'Steam Key Cyber Edition'
const VALORANT_ITEM_ID = '22222222-2222-2222-2222-222222222222'; // 'Valorant 1000 VP'

const buyerA = { id: 'buyer-a', username: 'BuyerA' };
const buyerB = { id: 'buyer-b', username: 'BuyerB' };

interface Booted {
  ctx: Context;
  mock: MockPlayerokTransport;
  dir: string;
}

/**
 * Bare automation stack: storage + blacklist + playerok + retry queue on a root Context,
 * every timer disabled. The root Context is where `autoDelivery` must be reachable —
 * a service provided inside a nested plugin would be invisible here.
 */
async function boot(dir: string = makeTempDir()): Promise<Booted> {
  const mock = new MockPlayerokTransport();
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: dir });
  await ctx.use(BlacklistService);
  await ctx.use(PlayerokService, { dryRun: true, enableMaintenanceLoops: false, transport: mock });
  await ctx.use(RetryQueueService, { enableTimer: false });
  mountAutomation(ctx, { enableTimers: false });

  // mountAutomation() does not await its plugins; cordis activates a fiber on the
  // microtask queue, so wait for the delivery service before touching it.
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && !ctx.get('autoDelivery', false)) {
    await sleep(5);
  }

  await ctx.playerok.connect();
  await ctx.playerok.startListening();
  return { ctx, mock, dir };
}

/** Patches the transport send so a test sees one call per goods key and can delay it. */
function instrumentSends(
  mock: MockPlayerokTransport,
  opts: { delayMs?: number; result?: null } = {},
): Array<{ key: string; phase: 'start' | 'end'; at: number }> {
  const events: Array<{ key: string; phase: 'start' | 'end'; at: number }> = [];
  const original = mock.sendMessage.bind(mock);
  mock.sendMessage = (async (params) => {
    const key = (params.text ?? '').match(/KEY-[A-Z0-9]+/)?.[0];
    if (!key) return original(params);
    events.push({ key, phase: 'start', at: Date.now() });
    if (opts.delayMs) await sleep(opts.delayMs);
    const message = opts.result === null ? null : await original(params);
    events.push({ key, phase: 'end', at: Date.now() });
    return message;
  }) as typeof mock.sendMessage;
  return events;
}

function sentKeys(mock: MockPlayerokTransport): string[] {
  return mock.sentMessages
    .map((m) => (m.text ?? '').match(/KEY-[A-Z0-9]+/)?.[0])
    .filter((key): key is string => Boolean(key));
}

describe('@pkh/plugin-automation: piece stock is reservation-based', () => {
  it('never reserves the same key twice for a deal that is replayed concurrently', async () => {
    const { ctx, mock } = await boot();
    ctx.storage.set('auto_deliveries', [
      { keyphrases: ['Steam Key'], piece: true, goods: ['KEY-001', 'KEY-002'] },
    ]);

    await Promise.all([
      mock.simulateNewDeal({ dealId: 'deal-dup', buyer: buyerA, chatId: 'chat-dup', itemId: STEAM_ITEM_ID }),
      mock.simulateNewDeal({ dealId: 'deal-dup', buyer: buyerA, chatId: 'chat-dup', itemId: STEAM_ITEM_ID }),
    ]);

    // One deal = one key, even though two NEW_DEAL events arrived at the same time.
    expect(sentKeys(mock)).toEqual(['KEY-001']);

    const rule = ctx.storage.getAutoDeliveries()[0];
    expect(rule.goods).toEqual(['KEY-002']);
    expect(rule.reserved ?? []).toEqual([]);

    await ctx.fiber.dispose();
  });

  it('lets two different deals send concurrently instead of serializing on the store lock', async () => {
    const { ctx, mock } = await boot();
    const DELAY = 400;
    const events = instrumentSends(mock, { delayMs: DELAY });

    ctx.storage.set('auto_deliveries', [
      { keyphrases: ['Steam Key'], piece: true, goods: ['KEY-A1'] },
      { keyphrases: ['Valorant'], piece: true, goods: ['KEY-B1'] },
    ]);

    await Promise.all([
      mock.simulateNewDeal({ dealId: 'deal-a', buyer: buyerA, chatId: 'chat-a', itemId: STEAM_ITEM_ID }),
      mock.simulateNewDeal({ dealId: 'deal-b', buyer: buyerB, chatId: 'chat-b', itemId: VALORANT_ITEM_ID }),
    ]);

    const at = (key: string, phase: 'start' | 'end'): number =>
      events.find((e) => e.key === key && e.phase === phase)?.at ?? Number.NaN;
    const startA = at('KEY-A1', 'start');
    const endA = at('KEY-A1', 'end');
    const startB = at('KEY-B1', 'start');
    const endB = at('KEY-B1', 'end');

    const sendWindow = Math.max(endA, endB) - Math.min(startA, startB);
    const serialized = endA - startA + (endB - startB);
    // Both network awaits are in flight at the same moment: the second send starts before
    // the first one ends. A single store lock held across the send cannot produce this
    // order — it forces startA, endA, startB, endB.
    expect(Math.max(startA, startB)).toBeLessThan(Math.min(endA, endB));
    // Wall-clock corroboration: the union window is shorter than the sum of both sends,
    // which is exactly what a serialized flow would take.
    expect(sendWindow).toBeLessThan(serialized);
    expect(sentKeys(mock).sort()).toEqual(['KEY-A1', 'KEY-B1']);

    const rules = ctx.storage.getAutoDeliveries();
    expect(rules[0].goods ?? []).toEqual([]);
    expect(rules[1].goods ?? []).toEqual([]);

    await ctx.fiber.dispose();
  });

  it('hands a different key to each of two concurrent deals on the same rule', async () => {
    const { ctx, mock } = await boot();
    instrumentSends(mock, { delayMs: 60 });
    ctx.storage.set('auto_deliveries', [
      { keyphrases: ['Steam Key'], piece: true, goods: ['KEY-S1', 'KEY-S2'] },
    ]);

    await Promise.all([
      mock.simulateNewDeal({ dealId: 'deal-s1', buyer: buyerA, chatId: 'chat-s1', itemId: STEAM_ITEM_ID }),
      mock.simulateNewDeal({ dealId: 'deal-s2', buyer: buyerB, chatId: 'chat-s2', itemId: STEAM_ITEM_ID }),
    ]);

    expect(sentKeys(mock).sort()).toEqual(['KEY-S1', 'KEY-S2']);
    const rule = ctx.storage.getAutoDeliveries()[0];
    expect(rule.goods ?? []).toEqual([]);
    expect(rule.reserved ?? []).toEqual([]);

    await ctx.fiber.dispose();
  });

  it('keeps a failed send reserved for the retry queue and takes it out of the sellable pool', async () => {
    const { ctx, mock } = await boot();
    instrumentSends(mock, { result: null });
    ctx.storage.set('auto_deliveries', [
      { keyphrases: ['Steam Key'], piece: true, goods: ['KEY-RETRY'] },
    ]);

    await mock.simulateNewDeal({
      dealId: 'deal-retry',
      buyer: buyerA,
      chatId: 'chat-retry',
      itemId: STEAM_ITEM_ID,
    });

    const rule = ctx.storage.getAutoDeliveries()[0];
    expect(rule.goods ?? []).not.toContain('KEY-RETRY');
    expect(rule.reserved).toEqual([
      { good: 'KEY-RETRY', dealId: 'deal-retry', at: expect.any(String) },
    ]);

    // The retry task owns the key, so the dedupe key must be unchanged.
    const tasks = ctx.retryQueue.list();
    expect(tasks.some((task) => task.dedupeKey === 'delivery:deal-retry:0')).toBe(true);

    await ctx.fiber.dispose();
  });

  it('returns the key to the sellable pool when the retry queue refuses the task', async () => {
    const { ctx, mock } = await boot();
    instrumentSends(mock, { result: null });
    ctx.retryQueue.enqueue = async () => {
      throw new Error('queue store unavailable');
    };
    ctx.storage.set('auto_deliveries', [
      { keyphrases: ['Steam Key'], piece: true, goods: ['KEY-ROLLBACK'] },
    ]);

    await mock.simulateNewDeal({
      dealId: 'deal-rollback',
      buyer: buyerA,
      chatId: 'chat-rollback',
      itemId: STEAM_ITEM_ID,
    });

    const rule = ctx.storage.getAutoDeliveries()[0];
    expect(rule.goods).toContain('KEY-ROLLBACK');
    expect(rule.reserved ?? []).toEqual([]);

    await ctx.fiber.dispose();
  });

  it('releases only expired reservations and is idempotent', async () => {
    const { ctx } = await boot();
    const now = new Date('2026-11-25T12:00:00.000Z');
    const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    ctx.storage.set('auto_deliveries', [
      {
        keyphrases: ['Steam Key'],
        piece: true,
        goods: ['KEY-SELLABLE'],
        reserved: [
          { good: 'KEY-STALE', dealId: 'deal-stale', at: stale },
          { good: 'KEY-LIVE', dealId: 'deal-live', at: fresh },
        ],
      },
    ]);

    expect(await ctx.autoDelivery.releaseStaleReservations(now)).toBe(1);

    let rule = ctx.storage.getAutoDeliveries()[0];
    expect(rule.goods).toEqual(['KEY-SELLABLE', 'KEY-STALE']);
    expect(rule.reserved).toEqual([{ good: 'KEY-LIVE', dealId: 'deal-live', at: fresh }]);

    // A second sweep on the same clock changes nothing.
    expect(await ctx.autoDelivery.releaseStaleReservations(now)).toBe(0);
    rule = ctx.storage.getAutoDeliveries()[0];
    expect(rule.goods).toEqual(['KEY-SELLABLE', 'KEY-STALE']);
    expect(rule.reserved).toEqual([{ good: 'KEY-LIVE', dealId: 'deal-live', at: fresh }]);

    await ctx.fiber.dispose();
  });

  it('keeps a key reserved while a live retry task still owns it, even past the TTL', async () => {
    const { ctx } = await boot();
    const now = new Date('2026-11-25T12:00:00.000Z');
    const stale = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    ctx.storage.set('auto_deliveries', [
      {
        keyphrases: ['Steam Key'],
        piece: true,
        goods: [],
        reserved: [{ good: 'KEY-IN-QUEUE', dealId: 'deal-queued', at: stale }],
      },
    ]);
    await ctx.retryQueue.enqueue({
      kind: 'send_message',
      payload: { chatId: 'chat-queued', text: 'KEY-IN-QUEUE' },
      dedupeKey: 'delivery:deal-queued:0',
    });

    // Releasing it would sell a key the queue is about to deliver.
    expect(await ctx.autoDelivery.releaseStaleReservations(now)).toBe(0);
    expect(ctx.storage.getAutoDeliveries()[0].reserved).toHaveLength(1);

    await ctx.fiber.dispose();
  });

  it('loads an old auto_deliveries.json that has no reserved field', async () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'bot_settings'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'bot_settings', 'auto_deliveries.json'),
      JSON.stringify(
        [{ keyphrases: ['Steam Key'], piece: true, goods: ['KEY-LEGACY-1', 'KEY-LEGACY-2'] }],
        null,
        2,
      ),
      'utf8',
    );

    const { ctx } = await boot(dir);

    const rules = ctx.storage.getAutoDeliveries();
    expect(rules).toHaveLength(1);
    expect(rules[0].goods).toEqual(['KEY-LEGACY-1', 'KEY-LEGACY-2']);
    expect(rules[0].reserved).toBeUndefined();
    // No schema mismatch: the file must not have been reset to defaults / backed up.
    expect(fs.existsSync(path.join(dir, 'bot_settings', 'auto_deliveries.json.bak'))).toBe(false);

    await ctx.fiber.dispose();
  });
});
