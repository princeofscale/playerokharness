import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessService,
  BlacklistService,
  BootReportService,
  Context,
  LogSinkService,
  PluginManagerService,
  PluginPermissionError,
  redactSecrets,
  safeEffect,
  safeInterval,
  StorageService,
  z,
} from '@pkh/core';
import { MockPlayerokTransport } from '@pkh/adapter';
import { TelegramService } from '@pkh/plugin-telegram';
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

  it('P0: safeEffect propagates async init errors (never silent) and runs cleanup on dispose', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(LogSinkService, { silentConsole: true });

    await expect(
      safeEffect(
        ctx,
        async () => {
          throw new Error('TCP handshake failed');
        },
        'test:tcpInit',
      ),
    ).rejects.toThrow('TCP handshake failed');

    expect(ctx.logSink.getRecentLines(10).join('\n')).toContain('TCP handshake failed');

    let cleaned = false;
    await safeEffect(
      ctx,
      async () => {
        return () => {
          cleaned = true;
        };
      },
      'test:cleanable',
    );
    expect(cleaned).toBe(false);
    await ctx.fiber.dispose();
    expect(cleaned).toBe(true);
  });

  it('P2: safeInterval stops firing automatically after context dispose (no zombie timers)', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });

    let ticks = 0;
    safeInterval(
      ctx,
      () => {
        ticks += 1;
      },
      15,
      'test:ticker',
    );

    await new Promise((r) => setTimeout(r, 55));
    const ticksBeforeDispose = ticks;
    expect(ticksBeforeDispose).toBeGreaterThanOrEqual(2);

    await ctx.fiber.dispose();
    await new Promise((r) => setTimeout(r, 60));
    expect(ticks).toBe(ticksBeforeDispose);
  });

  it('P1: validates plugin Zod config schema and enforces required plugins loudly', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(BootReportService);
    await ctx.use(PluginManagerService, { pluginsDir: path.join(dir, 'plugins') });

    const schema = z.object({
      apiEndpoint: z.string().url(),
      retries: z.number().int().positive(),
    });

    // Missing required config fields -> must fail validation & record boot error!
    await ctx.plugins.register(
      { id: 'strict_plugin', name: 'Strict Plugin', version: '1.0.0' },
      { name: 'strict_plugin', apply: () => {} },
      'external',
      { configSchema: schema },
    );

    const rec = ctx.plugins.get('strict_plugin');
    expect(rec?.enabled).toBe(false);
    expect(rec?.error).toContain('Некорректная конфигурация плагина');
    expect(ctx.bootReport.getErrors().some((e) => e.module === 'strict_plugin')).toBe(true);

    // Missing required plugin throws loud diagnostic error
    ctx.storage.updateConfig((cfg) => {
      cfg.plugins.required = ['nonexistent_plugin'];
    });
    expect(() => ctx.plugins.verifyRequiredPlugins()).toThrow('nonexistent_plugin');

    await ctx.fiber.dispose();
  });

  it('P1: TelegramService rejects malformed bot token before startup', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(AccessService);
    await ctx.use(BlacklistService);
    await ctx.use(PluginManagerService);

    await expect(async () => {
      await ctx.use(TelegramService, { token: 'invalid-token-format' });
    }).rejects.toThrow('Некорректный формат Telegram Bot Token');

    await ctx.fiber.dispose();
  });

  it('P2: isolates untrusted external plugins from secrets and sensitive services', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(AccessService);
    await ctx.use(PluginManagerService);

    ctx.storage.updateConfig((cfg) => {
      cfg.telegram.api.token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
      cfg.playerok.api.cookies = 'token=top_secret_cookie';
      cfg.telegram.bot.password = 'super_secret_pw';
    });

    let seenToken = 'UNSET';
    let seenCookies = 'UNSET';
    let accessBlocked = false;
    let setConfigBlocked = false;

    await ctx.plugins.register(
      { id: 'untrusted_mod', name: 'Untrusted Mod', version: '1.0.0' },
      {
        name: 'untrusted_mod',
        apply(pluginCtx) {
          const cfg = pluginCtx.storage.getConfig();
          seenToken = cfg.telegram.api.token;
          seenCookies = cfg.playerok.api.cookies;

          try {
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            pluginCtx.access;
          } catch (err) {
            accessBlocked = err instanceof PluginPermissionError;
          }

          try {
            pluginCtx.storage.setConfig(cfg);
          } catch (err) {
            setConfigBlocked = err instanceof PluginPermissionError;
          }
        },
      },
      'plugins/untrusted_mod.mjs',
      { trusted: false },
    );

    expect(seenToken).toBe('');
    expect(seenCookies).toBe('');
    expect(accessBlocked).toBe(true);
    expect(setConfigBlocked).toBe(true);

    await ctx.fiber.dispose();
  });
});
