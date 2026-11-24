import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Context,
  LogSinkService,
  PluginManagerService,
  redactSecrets,
  StorageService,
} from '@pkh/core';
import { MockPlayerokTransport } from '@pkh/adapter';
import { createApplication } from '@pkh/app';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-hardening-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.PKH_TELEGRAM_TOKEN;
  delete process.env.PKH_PLAYEROK_COOKIES;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Reliability, idempotency, concurrency & security hardening', () => {
  it('redacts Telegram tokens, cookies, Bearer tokens, and passwords in logs', async () => {
    const raw =
      'Failed for 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi cookie=secret123 token=eyJabc Bearer supersecret password=myPass';
    const masked = redactSecrets(raw);
    expect(masked).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi');
    expect(masked).not.toContain('secret123');
    expect(masked).not.toContain('eyJabc');
    expect(masked).not.toContain('supersecret');
    expect(masked).not.toContain('myPass');
    expect(masked).toContain('[REDACTED_TG_TOKEN]');

    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(LogSinkService, { silentConsole: true });
    ctx.logger('sec').info('Loaded token=very_secret_cookie_val');
    const lines = ctx.logSink.getRecentLines(5);
    expect(lines.join('\n')).not.toContain('very_secret_cookie_val');
    expect(lines.join('\n')).toContain('[REDACTED]');
    await ctx.fiber.dispose();
  });

  it('supports PKH_* environment variable secret overrides without mutating config.json', async () => {
    const dir = makeTempDir();
    process.env.PKH_TELEGRAM_TOKEN = '999999999:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    process.env.PKH_PLAYEROK_COOKIES = 'token=env_cookie; __ddg5_=env_ddg';

    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    const cfg = ctx.storage.getConfig();
    expect(cfg.telegram.api.token).toBe('999999999:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(cfg.playerok.api.cookies).toBe('token=env_cookie; __ddg5_=env_ddg');
    await ctx.fiber.dispose();
  });

  it('prevents double delivery & double stock consumption on duplicate NEW_DEAL events (idempotency)', async () => {
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

    app.ctx.storage.set('auto_deliveries', [
      { keyphrases: ['Steam Key'], piece: true, goods: ['KEY-ONLY-ONCE', 'KEY-SECOND'] },
    ]);
    await app.start();

    const buyer = { id: 'b-idem', username: 'IdemBuyer' };
    // Simulate exact same deal ID delivered twice!
    await mock.simulateNewDeal({
      dealId: 'deal-duplicate-001',
      buyer,
      chatId: 'chat-idem',
      itemId: '11111111-1111-1111-1111-111111111111',
    });
    await mock.simulateNewDeal({
      dealId: 'deal-duplicate-001',
      buyer,
      chatId: 'chat-idem',
      itemId: '11111111-1111-1111-1111-111111111111',
    });

    const deliveredMsgs = mock.sentMessages.filter((m) => m.text?.includes('KEY-ONLY-ONCE'));
    expect(deliveredMsgs).toHaveLength(1);
    expect(app.ctx.storage.getAutoDeliveries()[0].goods).toEqual(['KEY-SECOND']);
    expect(app.ctx.storage.isDealDelivered('deal-duplicate-001')).toBe(true);

    await app.stop();
  });

  it('isolates throwing plugin handlers so other plugins continue processing normally', async () => {
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

    let healthyPluginRan = false;
    // Register a faulty plugin that throws on every new-deal
    app.ctx.on('playerok/new-deal', async () => {
      throw new Error('Intentional plugin crash!');
    });
    // Register a healthy sibling plugin
    app.ctx.on('playerok/new-deal', () => {
      healthyPluginRan = true;
    });

    await app.start();
    await mock.simulateNewDeal({
      dealId: 'deal-fault-iso',
      buyer: { id: 'b-iso', username: 'IsoBuyer' },
      chatId: 'chat-iso',
      itemId: '11111111-1111-1111-1111-111111111111',
    });

    expect(healthyPluginRan).toBe(true);
    expect(app.ctx.storage.getCachedOrders()['deal-fault-iso']).toBeDefined();
    await app.stop();
  });

  it('serializes concurrent storage mutations via runExclusive without lost updates', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });

    await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        ctx.storage.runExclusive('initialized_users', async () => {
          const current = ctx.storage.getInitializedUsers();
          await new Promise((r) => setTimeout(r, 2));
          ctx.storage.set('initialized_users', [...current, `u-${idx}`]);
        }),
      ),
    );

    expect(ctx.storage.getInitializedUsers()).toHaveLength(10);
    await ctx.fiber.dispose();
  });

  it('reloads a plugin repeatedly with zero listener leaks', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(PluginManagerService, { pluginsDir: path.join(dir, 'plugins') });

    let calls = 0;
    await ctx.plugins.register(
      { id: 'reloadable', name: 'Reloadable', version: '1.0.0' },
      {
        name: 'reloadable',
        apply(c) {
          c.on('bot/init', () => {
            calls += 1;
          });
        },
      },
    );

    for (let i = 0; i < 5; i++) {
      await ctx.plugins.disable('reloadable');
      await ctx.plugins.enable('reloadable');
    }

    await ctx.parallel('bot/init');
    // Must be called exactly ONCE, proving zero listener accumulation
    expect(calls).toBe(1);

    await ctx.fiber.dispose();
  });
});
