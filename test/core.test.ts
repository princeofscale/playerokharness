import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessService,
  BlacklistService,
  Context,
  DEFAULT_CONFIG,
  formatTemplate,
  getCurrentBumpInterval,
  isCookiesValid,
  isNightTime,
  isProxyValid,
  isTgTokenValid,
  itemMatchesBinding,
  normalizeCustomApiUrl,
  parseItemRef,
  PluginManagerService,
  StorageService,
} from '@pkh/core';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-test-core-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('@pkh/core utilities', () => {
  it('formats nested templates safely while preserving unknown placeholders', () => {
    const out = formatTemplate('Привет, {user.username}! Товар «{item.name}» ({missing.key})', {
      user: { username: 'Alice' },
      item: { name: 'Steam Key' },
    });
    expect(out).toBe('Привет, Alice! Товар «Steam Key» ({missing.key})');
  });

  it('parses PlayerOK item refs (URL, UUID, slug)', () => {
    expect(parseItemRef('https://playerok.com/products/steam-key-123')).toEqual({
      kind: 'slug',
      value: 'steam-key-123',
    });
    expect(parseItemRef('11111111-1111-1111-1111-111111111111')).toEqual({
      kind: 'id',
      value: '11111111-1111-1111-1111-111111111111',
    });
    expect(() => parseItemRef('https://example.com/products/foo')).toThrow('playerok.com');
  });

  it('matches items by ID, slug, or case-insensitive keyphrase', () => {
    const item = { id: 'abc', slug: 'cool-item', name: 'Valorant 1000 VP' };
    expect(itemMatchesBinding(item, { items: [{ id: 'abc' }] })).toBe(true);
    expect(itemMatchesBinding(item, { items: [{ id: 'other', slug: 'cool-item' }] })).toBe(true);
    expect(itemMatchesBinding(item, { keyphrases: ['valorant'] })).toBe(true);
    expect(itemMatchesBinding(item, { keyphrases: ['steam'] })).toBe(false);
  });

  it('evaluates overnight bump schedule windows accurately', () => {
    const late = new Date('2026-11-24T23:30:00');
    const early = new Date('2026-11-24T04:15:00');
    const daytime = new Date('2026-11-24T14:00:00');
    expect(isNightTime('23:00', '08:00', late)).toBe(true);
    expect(isNightTime('23:00', '08:00', early)).toBe(true);
    expect(isNightTime('23:00', '08:00', daytime)).toBe(false);

    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.playerok.auto_bump_items.interval = 3600;
    cfg.playerok.auto_bump_items.night.enabled = true;
    cfg.playerok.auto_bump_items.night.interval = 14400;
    expect(getCurrentBumpInterval(cfg, late)).toBe(14400);
    expect(getCurrentBumpInterval(cfg, daytime)).toBe(3600);
  });

  it('validates tokens, cookies, proxies, and normalizes Cloudflare Worker URLs', () => {
    expect(isTgTokenValid('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi')).toBe(true);
    expect(isTgTokenValid('bad-token')).toBe(false);
    expect(isCookiesValid('token=abc; __ddg5_=xyz')).toBe(true);
    expect(isCookiesValid('invalid')).toBe(false);
    expect(isProxyValid('user:pass@192.168.1.10:8080')).toBe(true);
    expect(isProxyValid('999.1.1.1:80')).toBe(false);
    expect(normalizeCustomApiUrl('tg-proxy.demo.workers.dev/')).toBe('https://tg-proxy.demo.workers.dev');
  });
});

describe('@pkh/core Cordis services', () => {
  it('restores missing keys, recovers corrupt JSON with .bak, and rebinds items across stores', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });

    // Write partial config missing nested fields -> auto-restored
    const cfgPath = ctx.storage.getStorePath('config');
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({ logs: { max_file_size: 128 } }), 'utf8');

    const cfg = ctx.storage.getConfig();
    expect(cfg.logs.max_file_size).toBe(128);
    expect(cfg.playerok.watermark.enabled).toBe(true);

    // Corrupt JSON -> backed up to .bak and replaced with defaults
    fs.writeFileSync(cfgPath, '{broken json', 'utf8');
    const recovered = ctx.storage.getConfig();
    expect(recovered.logs.max_file_size).toBe(512);
    expect(fs.existsSync(`${cfgPath}.bak`)).toBe(true);

    // Rebind item across auto_deliveries & auto_restore_items
    ctx.storage.set('auto_deliveries', [
      { items: [{ id: 'old-id', slug: 'old-slug', name: 'Old' }], piece: false, message: ['hi'] },
    ]);
    ctx.storage.set('auto_restore_items', {
      included: [{ items: [{ id: 'old-id', slug: 'old-slug', name: 'Old' }] }],
      excluded: [],
    });

    const changed = ctx.storage.rebindItem('old-id', { id: 'new-id', slug: 'new-slug', name: 'New' });
    expect(changed).toBe(2);
    expect(ctx.storage.getAutoDeliveries()[0].items?.[0].id).toBe('new-id');
    expect((ctx.storage.getAutoRestoreItems().included[0] as { items: Array<{ id: string }> }).items[0].id).toBe(
      'new-id',
    );

    const snapshot = ctx.storage.exportSnapshot();
    expect('config' in snapshot).toBe(true);
    expect('owner_link' in snapshot).toBe(false);

    await ctx.fiber.dispose();
  });

  it('manages access ownership links, legacy passwords, and blacklist', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(AccessService);
    await ctx.use(BlacklistService);

    const code = ctx.access.getOwnerCode();
    expect(ctx.access.claimOwner(1001, 'wrong')).toBe(false);
    expect(ctx.access.claimOwner(1001, code)).toBe(true);
    expect(ctx.access.isSigned(1001)).toBe(true);
    // Second claim rejected once owner exists
    expect(ctx.access.claimOwner(1002, code)).toBe(false);

    expect(ctx.blacklist.add('@BadBuyer', 'chargeback')).toBe(true);
    expect(ctx.blacklist.isBlacklisted('badbuyer')).toBe(true);
    expect(ctx.blacklist.remove('BADBUYER')).toBe(true);
    expect(ctx.blacklist.isBlacklisted('BadBuyer')).toBe(false);

    await ctx.fiber.dispose();
  });

  it('dynamically loads external Cordis plugins and cleanly disposes them on disable', async () => {
    const dir = makeTempDir();
    const pluginsDir = path.join(dir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });

    const pluginFile = path.join(pluginsDir, 'counter.mjs');
    fs.writeFileSync(
      pluginFile,
      `
      export const meta = { id: 'counter', name: 'Counter', version: '1.0.0' };
      export function apply(ctx) {
        ctx.on('bot/init', () => {
          globalThis.__counterHits = (globalThis.__counterHits || 0) + 1;
        });
      }
      `,
      'utf8',
    );

    (globalThis as Record<string, unknown>).__counterHits = 0;

    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(PluginManagerService, { pluginsDir });

    const loaded = await ctx.plugins.discoverAndLoad();
    expect(loaded.map((p) => p.id)).toContain('counter');
    expect(ctx.plugins.get('counter')?.enabled).toBe(true);

    await ctx.parallel('bot/init');
    expect((globalThis as Record<string, unknown>).__counterHits).toBe(1);

    // Disable plugin -> Cordis disposes its fiber & removes event listener!
    await ctx.plugins.disable('counter');
    expect(ctx.plugins.get('counter')?.enabled).toBe(false);
    await ctx.parallel('bot/init');
    expect((globalThis as Record<string, unknown>).__counterHits).toBe(1);

    // Re-enable -> listener fires again
    await ctx.plugins.enable('counter');
    await ctx.parallel('bot/init');
    expect((globalThis as Record<string, unknown>).__counterHits).toBe(2);

    await ctx.fiber.dispose();
  });
});
