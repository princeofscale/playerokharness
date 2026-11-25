import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApplication } from '@pkh/app';
import { MockPlayerokTransport } from '@pkh/adapter';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-journey-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const SEED_ITEM = '11111111-1111-1111-1111-111111111111';

describe('operator journey: sale -> delivery -> analytics -> dashboard', () => {
  it('delivers the key, consumes stock, records the sale and exposes it over HTTP', async () => {
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
      webToken: 'journey-token',
    });

    app.ctx.storage.updateConfig((cfg) => {
      cfg.playerok.auto_complete_deals.enabled = true;
      cfg.playerok.auto_complete_deals.all = true;
    });
    app.ctx.storage.set('auto_deliveries', [
      { keyphrases: ['Steam Key'], piece: true, goods: ['JOURNEY-KEY-1', 'JOURNEY-KEY-2'] },
    ]);

    await app.start();

    const mock = app.ctx.playerok.transport as MockPlayerokTransport;
    await mock.simulateNewDeal({
      dealId: 'deal-journey-1',
      buyer: { id: 'buyer-journey', username: 'buyer_journey' },
      itemId: SEED_ITEM,
    });
    await sleep(120);

    // 1. The buyer received exactly one key and the stock was consumed.
    const sent = mock.sentMessages.map((message) => message.text ?? '').join('\n');
    expect(sent).toContain('JOURNEY-KEY-1');
    expect(sent).not.toContain('JOURNEY-KEY-2');

    const rules = app.ctx.storage.getAutoDeliveries();
    expect(rules[0]?.goods).toEqual(['JOURNEY-KEY-2']);
    expect(rules[0]?.reserved ?? []).toHaveLength(0);

    // 2. Delivery and completion are persisted, so a replay cannot deliver again.
    expect(app.ctx.storage.isDealDelivered('deal-journey-1')).toBe(true);
    expect(app.ctx.storage.isDealCompleted('deal-journey-1')).toBe(true);

    // 3. Analytics saw the sale.
    const analytics = app.ctx.get('analytics', false);
    expect(analytics).toBeTruthy();
    const summary = analytics!.getSummary({ period: 'day' });
    expect(summary.orders).toBe(1);
    expect(summary.revenue).toBeGreaterThan(0);

    // 4. The dashboard exposes the same state over HTTP.
    const address = app.ctx.get('webDashboard', false)?.address;
    expect(address).toBeTruthy();
    const origin = 'http://127.0.0.1:' + address!.port;

    const status = await fetch(origin + '/api/status?token=journey-token');
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { cachedOrders: number; ok: boolean };
    expect(statusBody.ok).toBe(true);
    expect(statusBody.cachedOrders).toBeGreaterThanOrEqual(1);

    const deals = await fetch(origin + '/api/deals?token=journey-token');
    const dealsBody = (await deals.json()) as { deals: Array<{ id: string }> };
    expect(dealsBody.deals.map((deal) => deal.id)).toContain('deal-journey-1');

    // 5. The action landed in the audit trail, and the dashboard reads the real service.
    const audit = app.ctx.get('audit', false);
    expect(audit).toBeTruthy();
    const entries = audit.list({ limit: 50 }) as Array<{ action: string; details?: { dealId?: string } }>;
    const delivered = entries.find(
      (entry) => entry.action === 'delivery.sent' && entry.details?.dealId === 'deal-journey-1',
    );
    expect(delivered).toBeTruthy();

    const auditJson = await fetch(origin + '/api/audit?limit=50&token=journey-token');
    expect(auditJson.status).toBe(200);
    const auditBody = (await auditJson.json()) as {
      available: boolean;
      entries: Array<{ action: string }>;
    };
    expect(auditBody.available).toBe(true);
    expect(auditBody.entries.map((entry) => entry.action)).toContain('delivery.sent');

    // 6. Prometheus metrics are served behind the same token.
    const metrics = await fetch(origin + '/metrics?token=journey-token');
    expect(metrics.status).toBe(200);
    const metricsBody = await metrics.text();
    expect(metricsBody).toContain('pkh_up 1');
    expect(metricsBody).toContain('pkh_deals_revenue_rub');
    expect(metricsBody).not.toContain('NaN');

    await app.stop();
  });
});
