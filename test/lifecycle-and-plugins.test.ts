import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BootReportService,
  compareVersions,
  Context,
  explainBootError,
  PluginManagerService,
  StorageService,
  UpdaterService,
  type SetupProblem,
} from '@pkh/core';
import { MockPlayerokTransport, UnauthorizedError } from '@pkh/adapter';
import { createApplication } from '@pkh/app';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-test-life-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('BootReportService, UpdaterService & Plugin subprocess verification', () => {
  it('tracks boot markers, explains errors, and formats HTML report', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(BootReportService);

    expect(explainBootError("SyntaxError: Unexpected token '}'")).toContain('синтаксическая ошибка');
    expect(explainBootError("Error: Cannot find package 'foo-bar'")).toContain('foo-bar');

    ctx.bootReport.setMarker('restart', 12345, 99);
    const marker = ctx.bootReport.popMarker();
    expect(marker?.action).toBe('restart');
    expect(ctx.bootReport.popMarker()).toBeNull();

    ctx.bootReport.addError('bad_plugin', 'load', "SyntaxError: bad file");
    ctx.bootReport.addNote('Тестовое примечание');

    const html = ctx.bootReport.formatReportHtml(marker, [
      { id: 'ok', meta: { id: 'ok', name: 'OK', version: '1.0.0' }, enabled: true, sourcePath: 'a.mjs' },
    ]);
    expect(html).toContain('Бот успешно перезапущен');
    expect(html).toContain('bad_plugin');
    expect(html).toContain('Тестовое примечание');

    await ctx.fiber.dispose();
  });

  it('compares semver versions and detects newer releases', async () => {
    expect(compareVersions('2.1.0', '2.0.0')).toBe(1);
    expect(compareVersions('v2.0.0', '2.0.0-alpha.1')).toBe(0);
    expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);

    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(UpdaterService, { currentVersion: '2.0.0', enableTimer: false });

    const latest = ctx.updater.pickLatest([
      { tagName: 'v1.5.0', name: '1.5', body: '', htmlUrl: '', publishedAt: '' },
      { tagName: 'v2.3.1', name: '2.3.1', body: 'New!', htmlUrl: '', publishedAt: '' },
      { tagName: 'v2.1.0', name: '2.1', body: '', htmlUrl: '', publishedAt: '' },
    ]);
    expect(latest?.tagName).toBe('v2.3.1');
    ctx.updater.latestRelease = latest;
    expect(ctx.updater.hasNewerRelease()).toBe(true);

    await ctx.fiber.dispose();
  });

  it('installs valid plugin via isolated subprocess check and rolls back broken updates', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(PluginManagerService, { pluginsDir: path.join(dir, 'plugins') });

    const goodCode = `
      export const meta = { id: 'safe_mod', name: 'Safe Mod', version: '1.0.0' };
      export function apply(ctx) {
        ctx.on('bot/init', () => {});
      }
    `;
    const r1 = await ctx.plugins.installPluginFile('safe_mod.mjs', goodCode);
    expect(r1.check.status).toBe('ok');
    expect(ctx.plugins.get('safe_mod')?.enabled).toBe(true);

    // Attempt to overwrite with broken syntax -> must fail check and roll back to v1.0.0!
    const brokenCode = `export function apply( { broken syntax!!!`;
    const r2 = await ctx.plugins.installPluginFile('safe_mod.mjs', brokenCode);
    expect(r2.check.status).toBe('error');
    expect(ctx.plugins.get('safe_mod')?.enabled).toBe(true);
    expect(ctx.plugins.get('safe_mod')?.meta.version).toBe('1.0.0');

    // Clean removal
    expect(await ctx.plugins.removePlugin('safe_mod')).toBe(true);
    expect(ctx.plugins.get('safe_mod')).toBeNull();

    await ctx.fiber.dispose();
  });

  it('enters Setup Mode on PlayerOK auth failure and launches live once fixed', async () => {
    const dir = makeTempDir();
    const mock = new MockPlayerokTransport();
    let shouldFail = true;
    const origGetAccount = mock.getAccount.bind(mock);
    mock.getAccount = async () => {
      if (shouldFail) throw new UnauthorizedError('cookies expired');
      return origGetAccount();
    };

    const app = await createApplication({
      dataDir: dir,
      dryRun: true,
      transport: mock,
      enableTelegram: false,
      enableTimers: false,
      enableInstanceLock: false,
      enableSetupMode: true,
      silentConsole: true,
    });

    const setupProblems: SetupProblem[] = [];
    let readyFired = false;
    app.ctx.on('bot/setup-mode', (p) => {
      setupProblems.push(p);
    });
    app.ctx.on('bot/ready', () => {
      readyFired = true;
    });

    await app.start();
    expect(app.isInSetupMode()).toBe(true);
    expect(setupProblems).toHaveLength(1);
    expect(setupProblems[0].code).toBe('unauthorized');
    expect(readyFired).toBe(false);

    // Fix auth and relaunch without process restart!
    shouldFail = false;
    const afterFix = await app.launchPlayerok();
    expect(afterFix).toBeNull();
    expect(app.isInSetupMode()).toBe(false);
    expect(readyFired).toBe(true);

    await app.stop();
  });

  it('pins plugin hashes, flags a mutated .mjs, and reports unrecorded plugins as unknown', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(BootReportService);
    const pluginsDir = path.join(dir, 'plugins');
    await ctx.use(PluginManagerService, { pluginsDir });

    const code =
      "export const meta = { id: 'sealed_mod', name: 'Sealed', version: '1.0.0' };\n" +
      'export function apply(ctx) {}\n';
    const installed = await ctx.plugins.installPluginFile('sealed_mod.mjs', code);
    expect(installed.check.status).toBe('ok');

    const fresh = ctx.plugins.verifyPluginIntegrity().find((r) => r.id === 'sealed_mod');
    expect(fresh?.ok).toBe(true);
    expect(fresh?.state).toBe('ok');
    expect(fresh?.expected).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh?.actual).toBe(fresh?.expected);

    // The manifest is the operator-visible record of what was installed.
    const manifestPath = path.join(dir, 'bot_data', 'plugin_integrity.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      plugins: Record<string, { sha256: string; size: number; installedAt: string }>;
    };
    const pinned = manifest.plugins.sealed_mod;
    expect(pinned?.sha256).toBe(fresh?.expected);
    expect(pinned?.size).toBe(Buffer.byteLength(code));
    expect(Number.isNaN(Date.parse(pinned?.installedAt ?? ''))).toBe(false);

    // Same-length tamper: only the hash can catch it.
    fs.writeFileSync(path.join(pluginsDir, 'sealed_mod.mjs'), code.replace('Sealed', 'Hacked'), 'utf8');
    const tampered = ctx.plugins.verifyPluginIntegrity().find((r) => r.id === 'sealed_mod');
    expect(tampered?.ok).toBe(false);
    expect(tampered?.state).toBe('mismatch');
    expect(tampered?.actual).not.toBe(tampered?.expected);

    // Loud, but not blocking: the modified file loaded earlier keeps running while the
    // boot report carries the mismatch under the plugin id with stage 'load'.
    const reported = ctx.bootReport
      .getErrors()
      .filter((e) => e.module === 'sealed_mod' && e.stage === 'load');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.trace).toContain('sealed_mod.mjs');

    // Re-verifying the same mismatch must not spam duplicate report entries.
    ctx.plugins.verifyPluginIntegrity();
    expect(
      ctx.bootReport.getErrors().filter((e) => e.module === 'sealed_mod' && e.stage === 'load'),
    ).toHaveLength(1);

    // A file the manager never installed has no baseline: unknown, and never ok.
    fs.writeFileSync(path.join(pluginsDir, 'stranger.mjs'), 'export function apply() {}\n', 'utf8');
    const stranger = ctx.plugins.verifyPluginIntegrity().find((r) => r.id === 'stranger');
    expect(stranger?.state).toBe('unknown');
    expect(stranger?.ok).toBe(false);
    expect(stranger?.expected).toBeNull();
    expect(stranger?.actual).toMatch(/^[0-9a-f]{64}$/);

    await ctx.fiber.dispose();
  });

  it('baselines a hand-copied plugin on discovery and never re-blesses a later edit', async () => {
    const dir = makeTempDir();
    const pluginsDir = path.join(dir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const file = path.join(pluginsDir, 'manual_mod.mjs');
    fs.writeFileSync(
      file,
      'export const meta = { id: "manual_mod", name: "Manual", version: "1.0.0" };\nexport function apply(ctx) {}\n',
      'utf8',
    );

    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(BootReportService);
    await ctx.use(PluginManagerService, { pluginsDir });

    // Nothing pinned before discovery.
    expect(ctx.plugins.verifyPluginIntegrity().find((r) => r.id === 'manual_mod')?.state).toBe('unknown');

    const loaded = await ctx.plugins.discoverAndLoad();
    expect(loaded.map((p) => p.id)).toContain('manual_mod');
    expect(ctx.plugins.verifyPluginIntegrity().find((r) => r.id === 'manual_mod')?.state).toBe('ok');

    // An external edit after the baseline stays a mismatch across a re-discovery
    // (discovery must not overwrite an existing pin with the new bytes).
    fs.writeFileSync(file, 'export function apply(ctx) {}\n// tampered\n', 'utf8');
    await ctx.plugins.discoverAndLoad();
    const after = ctx.plugins.verifyPluginIntegrity().find((r) => r.id === 'manual_mod');
    expect(after?.state).toBe('mismatch');
    expect(after?.ok).toBe(false);
    expect(
      ctx.bootReport.getErrors().some((e) => e.module === 'manual_mod' && e.stage === 'load'),
    ).toBe(true);

    await ctx.fiber.dispose();
  });
});
