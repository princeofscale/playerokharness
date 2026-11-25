import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApplication } from '@pkh/app';
import { MockPlayerokTransport } from '@pkh/adapter';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-web-app-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('createApplication web dashboard wiring', () => {
  it('mounts the dashboard and serves /healthz when enableWeb is set', async () => {
    const app = await createApplication({
      dataDir: makeTempDir(),
      dryRun: true,
      transport: new MockPlayerokTransport(),
      enableTelegram: false,
      enableTimers: false,
      enableInstanceLock: false,
      silentConsole: true,
      enableWeb: true,
      webPort: 0,
      webToken: 'integration-token',
    });

    const dashboard = app.ctx.get('webDashboard', false);
    expect(dashboard).toBeTruthy();
    const address = dashboard?.address;
    expect(address).toBeTruthy();

    const base = `http://127.0.0.1:${address!.port}`;
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect((await health.json() as { ok: boolean }).ok).toBe(true);

    // The overview is token-gated.
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/?token=integration-token`)).status).toBe(200);

    await app.stop();
    expect(dashboard?.address).toBeNull();
  });

  it('mounts analytics on the root context and records a real deal', async () => {
    const app = await createApplication({
      dataDir: makeTempDir(),
      dryRun: true,
      transport: new MockPlayerokTransport(),
      enableTelegram: false,
      enableTimers: false,
      enableInstanceLock: false,
      silentConsole: true,
    });

    const analytics = app.ctx.get('analytics', false);
    expect(analytics).toBeTruthy();
    await app.start();

    const mock = app.ctx.playerok.transport as MockPlayerokTransport;
    await mock.simulateNewDeal({
      dealId: 'deal-analytics-app',
      buyer: { id: 'buyer-app', username: 'buyer_app' },
      itemId: '11111111-1111-1111-1111-111111111111',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const summary = analytics!.getSummary({ period: 'day' });
    expect(summary.orders).toBe(1);
    expect(summary.revenue).toBeGreaterThan(0);

    await app.stop();
  });

  it('does not listen when enableWeb is not requested', async () => {
    const app = await createApplication({
      dataDir: makeTempDir(),
      dryRun: true,
      transport: new MockPlayerokTransport(),
      enableTelegram: false,
      enableTimers: false,
      enableInstanceLock: false,
      silentConsole: true,
    });

    expect(app.ctx.get('webDashboard', false)?.address ?? null).toBeNull();
    await app.stop();
  });
});
