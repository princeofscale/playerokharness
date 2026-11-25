import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApplication } from '@pkh/app';
import { MockPlayerokTransport } from '@pkh/adapter';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-settle-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('queued delivery settlement', () => {
  it('clears the reservation as soon as the retried send succeeds', async () => {
    const app = await createApplication({
      dataDir: makeTempDir(),
      dryRun: true,
      transport: new MockPlayerokTransport(),
      enableTelegram: false,
      enableTimers: false,
      enableInstanceLock: false,
      silentConsole: true,
    });

    app.ctx.storage.set('auto_deliveries', [
      {
        keyphrases: ['Steam Key'],
        piece: true,
        goods: ['KEY-B'],
        reserved: [{ good: 'KEY-A', dealId: 'deal-queued', at: new Date().toISOString() }],
      },
    ]);

    await app.ctx.parallel('retry/succeeded', {
      id: 'task-queued',
      kind: 'send_message',
      dedupeKey: 'delivery:deal-queued:0',
      payload: { chatId: 'chat-1', text: 'KEY-A' },
      attempts: 1,
      maxAttempts: 5,
      nextRunAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      status: 'processing',
    });
    await sleep(30);

    const rules = app.ctx.storage.getAutoDeliveries();
    expect(rules[0]?.reserved ?? []).toHaveLength(0);
    expect(rules[0]?.goods).toEqual(['KEY-B']);
    expect(app.ctx.storage.isDealDelivered('deal-queued')).toBe(true);

    await app.stop();
  });

  it('ignores tasks that are not queued deliveries', async () => {
    const app = await createApplication({
      dataDir: makeTempDir(),
      dryRun: true,
      transport: new MockPlayerokTransport(),
      enableTelegram: false,
      enableTimers: false,
      enableInstanceLock: false,
      silentConsole: true,
    });

    app.ctx.storage.set('auto_deliveries', [
      {
        keyphrases: ['Steam Key'],
        piece: true,
        goods: ['KEY-B'],
        reserved: [{ good: 'KEY-A', dealId: 'deal-other', at: new Date().toISOString() }],
      },
    ]);

    await app.ctx.parallel('retry/succeeded', {
      id: 'task-other',
      kind: 'bump_item',
      dedupeKey: 'bump:item-1',
      payload: {},
      attempts: 1,
      maxAttempts: 5,
      nextRunAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      status: 'processing',
    });
    await sleep(30);

    expect(app.ctx.storage.getAutoDeliveries()[0]?.reserved).toHaveLength(1);

    await app.stop();
  });
});
