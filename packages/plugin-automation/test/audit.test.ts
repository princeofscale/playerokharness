import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuditService,
  BlacklistService,
  Context,
  StorageService,
  type AuditEntry,
} from '@pkh/core';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import { RetryQueueService } from '@pkh/plugin-retry-queue';
import { mountAutomation } from '@pkh/plugin-automation';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-audit-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const STEAM_ITEM_ID = '11111111-1111-1111-1111-111111111111';
const buyerA = { id: 'buyer-a', username: 'BuyerA' };

/** Boots only what the audit trail needs: storage for the data dir, then the service. */
async function bootAudit(dir: string = makeTempDir()): Promise<{ ctx: Context; audit: AuditService }> {
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: dir });
  await ctx.use(AuditService);
  return { ctx, audit: mustAudit(ctx) };
}

/** The trail service stays optional: read it by name, exactly like its consumers do. */
function mustAudit(ctx: Context): AuditService {
  const audit = ctx.get('audit', false) as AuditService | undefined;
  if (!audit) throw new Error('AuditService is not reachable through ctx.get');
  return audit;
}

/**
 * Runs a list() call while counting the bytes the reader actually pulls off disk, so a
 * test can prove the tail window is used instead of parsing the whole megabyte.
 */
function listCountingReads(
  audit: AuditService,
  limit: number,
): { entries: AuditEntry[]; bytesRead: number } {
  const original = fs.readSync;
  let bytesRead = 0;
  const patched = ((
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    bytesRead += length;
    return original(fd, buffer, offset, length, position);
  }) as unknown as typeof fs.readSync;

  (fs as unknown as { readSync: typeof fs.readSync }).readSync = patched;
  try {
    const entries = audit.list({ limit });
    return { entries, bytesRead };
  } finally {
    (fs as unknown as { readSync: typeof fs.readSync }).readSync = original;
  }
}

interface Stack {
  ctx: Context;
  mock: MockPlayerokTransport;
  dir: string;
}

/**
 * The automation stack from stock.test.ts, with the audit service optional: the whole
 * point of the integration is that automation must work when nobody mounted it.
 */
async function bootStack(options: { withAudit: boolean }): Promise<Stack> {
  const dir = makeTempDir();
  const mock = new MockPlayerokTransport();
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: dir });
  await ctx.use(BlacklistService);
  if (options.withAudit) await ctx.use(AuditService);
  await ctx.use(PlayerokService, { dryRun: true, enableMaintenanceLoops: false, transport: mock });
  await ctx.use(RetryQueueService, { enableTimer: false });
  mountAutomation(ctx, { enableTimers: false });

  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && !ctx.get('autoDelivery', false)) {
    await sleep(5);
  }

  await ctx.playerok.connect();
  await ctx.playerok.startListening();
  return { ctx, mock, dir };
}

/** Makes every goods send return null so the automation falls back to the retry queue. */
function failSends(mock: MockPlayerokTransport): void {
  const original = mock.sendMessage.bind(mock);
  mock.sendMessage = (async (params) => {
    if (!(params.text ?? '').match(/KEY-[A-Z0-9]+/)) return original(params);
    return null;
  }) as typeof mock.sendMessage;
}

function sentKeys(mock: MockPlayerokTransport): string[] {
  return mock.sentMessages
    .map((m) => (m.text ?? '').match(/KEY-[A-Z0-9]+/)?.[0])
    .filter((key): key is string => Boolean(key));
}

describe('@pkh/core AuditService', () => {
  it('appends one JSON object per line and lists newest-first', async () => {
    const { ctx, audit } = await bootAudit();

    const first = audit.record({
      action: 'delivery.sent',
      title: 'Первый',
      at: '2026-11-25T10:00:00.000Z',
      details: { dealId: 'deal-1', amount: 500 },
    });
    audit.record({
      action: 'bump.ok',
      title: 'Второй',
      outcome: 'skipped',
      at: '2026-11-25T10:00:01.000Z',
    });

    expect(first).toMatchObject({ action: 'delivery.sent', actor: 'auto', outcome: 'ok' });

    const list = audit.list();
    expect(list.map((entry) => entry.title)).toEqual(['Второй', 'Первый']);
    expect(list[0]).toMatchObject({ action: 'bump.ok', outcome: 'skipped' });
    expect(list[1].details).toEqual({ dealId: 'deal-1', amount: 500 });
    expect(list[1].at).toBe('2026-11-25T10:00:00.000Z');

    const raw = fs.readFileSync(audit.filePath, 'utf8').trim().split('\n');
    expect(raw).toHaveLength(2);
    expect(JSON.parse(raw[0])).toMatchObject({ action: 'delivery.sent', actor: 'auto' });

    await ctx.fiber.dispose();
  });

  it('filters by since (inclusive) and by action', async () => {
    const { ctx, audit } = await bootAudit();
    const at = (second: number): string => `2026-11-25T10:00:${String(second).padStart(2, '0')}.000Z`;

    audit.record({ action: 'delivery.sent', title: 'a', at: at(0) });
    audit.record({ action: 'delivery.sent', title: 'b', at: at(10) });
    audit.record({ action: 'bump.ok', title: 'c', at: at(20) });

    expect(audit.list({ action: 'delivery.sent' }).map((e) => e.title)).toEqual(['b', 'a']);
    expect(audit.list({ since: at(10) }).map((e) => e.title)).toEqual(['c', 'b']);
    expect(audit.list({ action: 'bump.ok', since: at(30) })).toEqual([]);
    expect(audit.list({ limit: 1 }).map((e) => e.title)).toEqual(['c']);
    // The web/telegram screens probe list.length to decide whether they may pass options;
    // an optional-but-not-defaulted parameter keeps that probe at 1.
    expect(audit.list.length).toBe(1);
    expect(audit.stats()).toMatchObject({
      entries: 3,
      oldestAt: at(0),
      newestAt: at(20),
    });

    await ctx.fiber.dispose();
  });

  it('reads only the tail of a log larger than 1 MB', async () => {
    const { ctx, audit } = await bootAudit();
    const file = audit.filePath;
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const filler = 'x'.repeat(2000);
    let raw = '';
    for (let index = 0; index < 600; index += 1) {
      raw +=
        JSON.stringify({
          at: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
          action: 'delivery.sent',
          actor: 'auto',
          outcome: 'ok',
          title: 'entry-' + String(index),
          details: { filler },
        }) + '\n';
    }
    fs.writeFileSync(file, raw, 'utf8');
    const size = fs.statSync(file).size;
    expect(size).toBeGreaterThan(1024 * 1024);

    const { entries: list, bytesRead } = listCountingReads(audit, 5);

    expect(list.map((entry) => entry.title)).toEqual([
      'entry-599',
      'entry-598',
      'entry-597',
      'entry-596',
      'entry-595',
    ]);
    // The window is a few kilobytes, not the whole megabyte.
    expect(bytesRead).toBeLessThan(size / 10);

    await ctx.fiber.dispose();
  });
});
describe('@pkh/core AuditService retention', () => {
  it('prunes to the newest entries and honours maxEntries', async () => {
    const { ctx, audit } = await bootAudit();
    const start = Date.UTC(2026, 10, 1);
    for (let index = 0; index < 40; index += 1) {
      audit.record({
        action: 'delivery.sent',
        title: 'e' + String(index),
        at: new Date(start + index * 60_000).toISOString(),
      });
    }
    audit.record({ action: 'delivery.sent', title: 'ancient', at: '2020-01-01T00:00:00.000Z' });

    const result = audit.prune({ maxEntries: 10, maxBytes: 1024 * 1024, maxAgeDays: 90 });
    expect(result).toMatchObject({ kept: 10, removed: 31 });

    const titles = audit.list({ limit: 100 }).map((entry) => entry.title);
    expect(titles).toHaveLength(10);
    expect(titles[0]).toBe('e39');
    expect(titles[9]).toBe('e30');
    expect(titles).not.toContain('ancient');

    // Same bounds again: nothing left to drop, the file is not rewritten.
    expect(audit.prune({ maxEntries: 10, maxBytes: 1024 * 1024, maxAgeDays: 90 })).toMatchObject({
      kept: 10,
      removed: 0,
    });

    // A byte budget trims from the old end and keeps the newest.
    const byteLimited = audit.prune({ maxEntries: 1000, maxBytes: 400, maxAgeDays: 90 });
    expect(byteLimited.kept).toBeLessThan(10);
    expect(audit.list({ limit: 100 })[0].title).toBe('e39');

    await ctx.fiber.dispose();
  });

  it('rotates an oversized log to a single archive', async () => {
    const { ctx, audit } = await bootAudit();
    for (let index = 0; index < 30; index += 1) {
      audit.record({ action: 'delivery.sent', title: 'big-' + String(index), details: { pad: 'p'.repeat(1000) } });
    }
    expect(audit.rotate()).toBe(true);
    expect(fs.existsSync(audit.archivePath)).toBe(true);
    expect(audit.stats().entries).toBe(0);

    // The archive is kept, the live file restarts empty.
    audit.record({ action: 'bump.ok', title: 'after' });
    expect(audit.list({ limit: 5 }).map((entry) => entry.title)).toEqual(['after']);
    expect(fs.statSync(audit.archivePath).size).toBeGreaterThan(0);

    await ctx.fiber.dispose();
  });

  it('redacts telegram tokens and cookie headers before writing', async () => {
    const { ctx, audit } = await bootAudit();
    const token = '123456789:' + 'A'.repeat(35);
    const cookie = 'Cookie: PHPSESSID=deadbeefcafe; __ddg5_=s3cr3tvalue';

    audit.record({
      action: 'system.check',
      actor: 'system',
      title: 'probe ' + token,
      details: {
        botToken: token,
        headers: cookie,
        note: 'Authorization: Bearer abcdef123456',
        session: 'opaque-session',
        nested: { token },
      },
    });

    const raw = fs.readFileSync(audit.filePath, 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('deadbeefcafe');
    expect(raw).not.toContain('s3cr3tvalue');
    expect(raw).not.toContain('abcdef123456');
    expect(raw).toContain('[REDACTED');

    // Redaction keeps the record parseable and its shape intact.
    const entry = audit.list({ limit: 1 })[0];
    expect(entry.action).toBe('system.check');
    expect(entry.actor).toBe('system');
    expect(entry.details?.session).toBe('[REDACTED]');
    expect(typeof entry.details?.note).toBe('string');

    await ctx.fiber.dispose();
  });

  it('never throws into the caller when the log cannot be written', async () => {
    const { ctx, audit } = await bootAudit();
    // A directory where the log file should be makes every append fail.
    fs.mkdirSync(audit.filePath, { recursive: true });

    expect(() => audit.record({ action: 'delivery.sent', title: 'boom' })).not.toThrow();
    expect(audit.record({ action: 'delivery.sent', title: 'boom' })).toBeNull();
    expect(audit.list()).toEqual([]);

    await ctx.fiber.dispose();
  });
});

describe('@pkh/plugin-automation audit integration', () => {
  it('delivers a deal with no audit service mounted', async () => {
    const { ctx, mock, dir } = await bootStack({ withAudit: false });
    ctx.storage.set('auto_deliveries', [
      { keyphrases: ['Steam Key'], piece: true, goods: ['KEY-NOAUDIT'] },
    ]);

    await mock.simulateNewDeal({
      dealId: 'deal-noaudit',
      buyer: buyerA,
      chatId: 'chat-noaudit',
      itemId: STEAM_ITEM_ID,
    });

    expect(sentKeys(mock)).toEqual(['KEY-NOAUDIT']);
    expect(ctx.get('audit', false)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'bot_data', 'audit.jsonl'))).toBe(false);

    await ctx.fiber.dispose();
  });

  it('records one delivery fact per deal even when two rules match', async () => {
    const { ctx, mock } = await bootStack({ withAudit: true });
    const audit = mustAudit(ctx);
    ctx.storage.set('auto_deliveries', [
      { keyphrases: ['Steam Key'], piece: true, goods: ['KEY-FIRST'] },
      { keyphrases: ['Steam Key'], piece: true, goods: ['KEY-SECOND'] },
    ]);

    await mock.simulateNewDeal({
      dealId: 'deal-audit',
      buyer: buyerA,
      chatId: 'chat-audit',
      itemId: STEAM_ITEM_ID,
    });

    const sent = audit.list({ action: 'delivery.sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ actor: 'auto', outcome: 'ok' });
    expect(sent[0].details).toMatchObject({ dealId: 'deal-audit', itemId: STEAM_ITEM_ID });
    expect(audit.list({ action: 'delivery.reserved' })).toHaveLength(1);

    // The delivered goods value is a secret of the sale: it must never be in the trail.
    const raw = fs.readFileSync(audit.filePath, 'utf8');
    expect(raw).not.toContain('KEY-FIRST');
    expect(raw).not.toContain('KEY-SECOND');

    await ctx.fiber.dispose();
  });

  it('records a queued retry when the delivery send fails', async () => {
    const { ctx, mock } = await bootStack({ withAudit: true });
    const audit = mustAudit(ctx);
    failSends(mock);
    ctx.storage.set('auto_deliveries', [
      { keyphrases: ['Steam Key'], piece: true, goods: ['KEY-QUEUED'] },
    ]);

    await mock.simulateNewDeal({
      dealId: 'deal-queued',
      buyer: buyerA,
      chatId: 'chat-queued',
      itemId: STEAM_ITEM_ID,
    });

    const queued = audit.list({ action: 'delivery.queued' });
    expect(queued).toHaveLength(1);
    expect(queued[0].details).toMatchObject({ dealId: 'deal-queued' });
    expect(audit.list({ action: 'delivery.sent' })).toEqual([]);

    await ctx.fiber.dispose();
  });

  it('records the auto-complete result of a deal', async () => {
    const { ctx, mock } = await bootStack({ withAudit: true });
    const audit = mustAudit(ctx);
    ctx.storage.updateConfig((cfg) => {
      cfg.playerok.auto_complete_deals.enabled = true;
      cfg.playerok.auto_complete_deals.all = true;
    });

    await mock.simulateNewDeal({
      dealId: 'deal-complete',
      buyer: buyerA,
      chatId: 'chat-complete',
      itemId: STEAM_ITEM_ID,
    });

    const completed = audit.list({ action: 'auto-complete.sent' });
    expect(completed).toHaveLength(1);
    expect(completed[0].details).toMatchObject({ dealId: 'deal-complete' });

    await ctx.fiber.dispose();
  });
});
