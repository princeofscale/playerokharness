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
} from '@pkh/core';

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
