import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Context,
  PluginManagerService,
  PluginPermissionError,
  pruneIdempotencyMarkers,
  safeInterval,
  StorageService,
} from '@pkh/core';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import { RetryQueueService } from '@pkh/plugin-retry-queue';
import { redactSnapshotSecrets } from '@pkh/plugin-telegram';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-regress-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('Regression guards for the 2026-11-25 code review', () => {
  it('evicts idempotency markers by age, not by insertion order', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const map: Record<string, string> = {
      ancient: new Date(now - 45 * day).toISOString(),
      recent: new Date(now - 2 * day).toISOString(),
      malformed: 'not-a-date',
    };

    pruneIdempotencyMarkers(map, now);

    // A replayed NEW_DEAL 45 days later must never re-deliver goods, but a marker
    // that is still inside the catch-up window has to survive.
    expect(map.ancient).toBeUndefined();
    expect(map.malformed).toBeUndefined();
    expect(map.recent).toBeDefined();
  });

  it('caps the idempotency store by oldest timestamp instead of object key order', () => {
    const now = Date.now();
    const map: Record<string, string> = {};
    for (let i = 0; i < 5010; i += 1) {
      map['deal-' + i] = new Date(now - i * 1000).toISOString();
    }

    pruneIdempotencyMarkers(map, now);

    expect(Object.keys(map).length).toBe(5000);
    expect(map['deal-0']).toBeDefined();
    expect(map['deal-5009']).toBeUndefined();
  });

  it('skips an overlapping safeInterval tick instead of running the task twice', async () => {
    const ctx = new Context();
    let concurrent = 0;
    let maxConcurrent = 0;
    let runs = 0;

    safeInterval(
      ctx,
      async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        runs += 1;
        await sleep(60);
        concurrent -= 1;
      },
      10,
      'regress:overlap',
    );

    await sleep(140);
    await ctx.fiber.dispose();

    expect(maxConcurrent).toBe(1);
    expect(runs).toBeLessThanOrEqual(3);
  });

  it('blocks untrusted plugins from rewriting the double-delivery guards', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(PluginManagerService);

    let setBlocked = false;
    let methodBlocked = false;
    let rebindBlocked = false;

    await ctx.plugins.register(
      { id: 'sneaky_mod', name: 'Sneaky Mod', version: '1.0.0' },
      {
        name: 'sneaky_mod',
        apply(pluginCtx) {
          try {
            pluginCtx.storage.set('idempotency', { delivered_deals: {}, completed_deals: {} });
          } catch (err) {
            setBlocked = err instanceof PluginPermissionError;
          }
          try {
            pluginCtx.storage.markDealDelivered('deal-1');
          } catch (err) {
            methodBlocked = err instanceof PluginPermissionError;
          }
          try {
            pluginCtx.storage.rebindItem('old', { id: 'new', slug: 's', name: 'n' });
          } catch (err) {
            rebindBlocked = err instanceof PluginPermissionError;
          }
        },
      },
      'plugins/sneaky_mod.mjs',
      { trusted: false },
    );

    expect(setBlocked).toBe(true);
    expect(methodBlocked).toBe(true);
    expect(rebindBlocked).toBe(true);

    await ctx.fiber.dispose();
  });

  it('strips secrets from the exported settings snapshot', () => {
    const snapshot = {
      config: {
        telegram: { api: { token: '123456789:ABCDEFGHIJ' }, bot: { password: 'pw' } },
        playerok: { api: { cookies: 'token=secret' } },
      },
      messages: { greeting: 'hi' },
    };

    const redacted = redactSnapshotSecrets(snapshot) as typeof snapshot;

    expect(redacted.config.telegram.api.token).toBe('');
    expect(redacted.config.telegram.bot.password).toBe('');
    expect(redacted.config.playerok.api.cookies).toBe('');
    expect(redacted.messages.greeting).toBe('hi');
    // The input snapshot must not be mutated in place.
    expect(snapshot.config.telegram.api.token).toBe('123456789:ABCDEFGHIJ');
  });

  it('reschedules a task whose handler is not registered yet instead of dead-lettering it', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(PlayerokService, {
      transport: new MockPlayerokTransport(),
      enableMaintenanceLoops: false,
    });
    await ctx.use(RetryQueueService, { enableTimer: false });

    const task = await ctx.retryQueue.enqueue({ kind: 'not_loaded_yet', payload: {} });
    const result = await ctx.retryQueue.processDue(new Date(Date.now() + 60_000));

    expect(result.deadLettered).toBe(0);
    expect(result.rescheduled).toBe(1);

    const stored = ctx.retryQueue.list('pending').find((t) => t.id === task.id);
    expect(stored?.attempts).toBe(1);

    await ctx.fiber.dispose();
  });
});
