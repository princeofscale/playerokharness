import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessService,
  BootReportService,
  Context,
  LogSinkService,
  StorageService,
  VERSION,
} from '@pkh/core';
import { buildDoctorReport } from '@pkh/app';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-core3-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('core round 3 hardening', () => {
  it('rotates oversized logs into archives instead of deleting the evidence', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(LogSinkService, { silentConsole: true });

    ctx.storage.updateConfig((cfg) => {
      cfg.logs.max_file_size = 0.0005; // ~512 bytes
    });

    const logPath = ctx.logSink.logFilePath;
    fs.writeFileSync(logPath, 'x'.repeat(2000), 'utf8');

    ctx.logSink.enforceMaxFileSize();
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.statSync(logPath).size).toBe(0);

    // A second oversized file shifts the first archive to .2.
    fs.writeFileSync(logPath, 'y'.repeat(2000), 'utf8');
    ctx.logSink.enforceMaxFileSize();
    expect(fs.existsSync(`${logPath}.2`)).toBe(true);
    expect(fs.readFileSync(`${logPath}.2`, 'utf8')).toBe('x'.repeat(2000));

    await ctx.fiber.dispose();
  });

  it('returns only the tail of a large log file', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(LogSinkService, { silentConsole: true });

    const logPath = ctx.logSink.logFilePath;
    fs.writeFileSync(logPath, Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n') + '\n', 'utf8');

    const tail = ctx.logSink.getRecentLines(5);
    expect(tail).toHaveLength(5);
    expect(tail[4]).toBe('line-499');

    await ctx.fiber.dispose();
  });

  it('prunes expired access requests from disk', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(AccessService);

    const ancient = Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60;
    ctx.storage.set('access_requests', {
      '111': { time: ancient, username: 'old', name: null },
      '222': { time: Math.floor(Date.now() / 1000), username: 'fresh', name: null },
    });

    expect(ctx.access.getRequest(111)).toBeNull();
    expect(ctx.access.getRequest(222)).not.toBeNull();

    const stored = ctx.storage.get<Record<string, unknown>>('access_requests');
    expect(Object.keys(stored)).toEqual(['222']);

    await ctx.fiber.dispose();
  });

  it('reports a corrupt store recovery once and keeps the .bak copy', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(BootReportService);

    const configPath = ctx.storage.getStorePath('config');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ this is not json', 'utf8');

    const recovered = ctx.storage.getConfig();
    expect(recovered.telegram).toBeDefined();
    expect(fs.existsSync(`${configPath}.bak`)).toBe(true);
    expect(fs.readFileSync(`${configPath}.bak`, 'utf8')).toBe('{ this is not json');

    const errors = ctx.bootReport.getErrors().filter((e) => e.stage === 'recover');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.module).toBe('config');

    // Reading it again must not duplicate the report entry.
    ctx.storage.getConfig();
    expect(ctx.bootReport.getErrors().filter((e) => e.stage === 'recover')).toHaveLength(1);

    await ctx.fiber.dispose();
  });
});

describe('pkh doctor report (--json source)', () => {
  it('builds one JSON object from an empty data dir without booting the app', async () => {
    const dir = makeTempDir();
    const report = await buildDoctorReport(dir);

    expect(report.version).toBe(VERSION);
    expect(report.dataDir).toBe(path.resolve(dir));
    expect(report.nodeVersion).toBe(process.version);
    expect(report.dataDirExists).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual([
      'node',
      'data-dir',
      'telegram-token',
      'playerok-cookies',
      'telegram-owners',
    ]);
    for (const check of report.checks) {
      expect(typeof check.label).toBe('string');
      expect(typeof check.detail).toBe('string');
      expect(typeof check.ok).toBe('boolean');
    }
    expect(report.checks.find((c) => c.id === 'node')?.ok).toBe(true);
    expect(report.queue).toBeNull();
    expect(report.bootMarker).toBeNull();
    expect(typeof report.web.enabled).toBe('boolean');
    expect(typeof report.web.port).toBe('string');
    expect(typeof report.web.tokenPresent).toBe('boolean');
    expect(report.pluginIntegrity).toEqual([]);
    expect(report.ok).toBe(false);

    // The CLI prints JSON.stringify(report): it must survive the round trip as exactly
    // one object with a stable key set.
    const json = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual([
      'bootMarker',
      'checks',
      'dataDir',
      'dataDirExists',
      'nodeVersion',
      'ok',
      'pluginIntegrity',
      'queue',
      'version',
      'web',
    ]);
  });

  it('reports queue depth, a boot marker and plugin integrity from disk', async () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'bot_data'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'bot_data', 'retry_queue.json'),
      JSON.stringify({
        tasks: [
          { id: 'a', status: 'pending' },
          { id: 'b', status: 'pending' },
          { id: 'c', status: 'dead' },
        ],
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'bot_data', 'boot_marker.json'),
      JSON.stringify({ action: 'restart', chat_id: 1, message_id: 2, timestamp: Date.now() }),
      'utf8',
    );
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugins', 'stray.mjs'), 'export function apply() {}\n', 'utf8');

    const report = await buildDoctorReport(dir);

    expect(report.queue).toEqual({ pending: 2, dead: 1 });
    expect(report.bootMarker?.action).toBe('restart');
    expect(typeof report.bootMarker?.timestamp).toBe('number');
    expect(report.pluginIntegrity).toHaveLength(1);
    expect(report.pluginIntegrity[0]).toMatchObject({
      id: 'stray',
      state: 'unknown',
      ok: false,
      expected: null,
    });
    expect(report.pluginIntegrity[0]?.actual).toMatch(/^[0-9a-f]{64}$/);
    expect(report.ok).toBe(false);

    // Optional integrity fields must be omitted from --json, never serialized as undefined.
    const json = JSON.parse(JSON.stringify(report)) as {
      pluginIntegrity: Array<Record<string, unknown>>;
      queue: Record<string, unknown>;
    };
    expect('installedAt' in json.pluginIntegrity[0]).toBe(false);
    expect(json.pluginIntegrity[0].path).toBe(path.join(dir, 'plugins', 'stray.mjs'));
    expect(json.queue).toEqual({ pending: 2, dead: 1 });
  });
});

describe('StorageService parsed-store cache', () => {
  it('serves a cached parse but observes set() and external file edits immediately', async () => {
    const dir = makeTempDir();
    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });

    const first = ctx.storage.getConfig();
    const hitsAfterFirst = ctx.storage.storeCache.hits;
    const second = ctx.storage.getConfig();
    expect(ctx.storage.storeCache.hits).toBe(hitsAfterFirst + 1);
    expect(second.logs.max_file_size).toBe(first.logs.max_file_size);

    // A caller mutating the returned object must not poison the cached value.
    second.logs.max_file_size = 12345;
    expect(ctx.storage.getConfig().logs.max_file_size).toBe(first.logs.max_file_size);

    // set() is visible on the very next read.
    ctx.storage.updateConfig((cfg) => {
      cfg.logs.max_file_size = 777;
    });
    expect(ctx.storage.getConfig().logs.max_file_size).toBe(777);
    expect(ctx.storage.storeCache.writes).toBe(1);

    // An external edit of the store file is picked up without a restart. The value
    // keeps the same byte length, so only mtime/revision can invalidate the cache.
    const cfgPath = ctx.storage.getStorePath('config');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
      logs: { max_file_size: number };
    };
    raw.logs.max_file_size = 888;
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8');
    expect(ctx.storage.getConfig().logs.max_file_size).toBe(888);

    raw.logs.max_file_size = 999;
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8');
    expect(ctx.storage.getConfig().logs.max_file_size).toBe(999);

    await ctx.fiber.dispose();
  });
});
