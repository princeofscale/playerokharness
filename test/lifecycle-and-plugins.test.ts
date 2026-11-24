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
} from '@playerok/core';
import { MockPlayerokTransport, UnauthorizedError } from '@playerok/adapter';
import { createApplication } from '@playerok/app';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playerok-v2-life-'));
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
});
