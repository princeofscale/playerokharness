import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Context, PluginManagerService, Service, StorageService } from '@pkh/core';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import { escapePrometheusLabelValue, WebDashboardService } from '@pkh/plugin-web';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-web-metrics-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Built without escapes so the test bodies stay readable. */
const LF = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

interface Harness {
  ctx: Context;
  dashboard: WebDashboardService;
  baseUrl: string;
  token: string;
}

interface StubAuditConfig {
  rows?: unknown[];
  /** When set, list() throws this message, simulating a broken service. */
  error?: string;
}

/**
 * Structurally compatible stand-in for the optional audit service. It is a real
 * Cordis service so the dashboard finds it through ctx.get('audit', false).
 */
class StubAuditService extends Service {
  static provide = 'audit';

  public listCalls = 0;
  private readonly config: StubAuditConfig;

  constructor(ctx: Context, config: StubAuditConfig = {}) {
    super(ctx, 'audit');
    this.config = config;
  }

  public list(options?: { limit?: number }): unknown[] {
    this.listCalls += 1;
    if (this.config.error !== undefined) throw new Error(this.config.error);
    const rows = this.config.rows ?? [];
    const limit = options?.limit;
    return limit === undefined ? rows.slice() : rows.slice(0, limit);
  }

  public stats(): unknown {
    return {
      total: (this.config.rows ?? []).length,
      byAction: { 'deal.deliver': 2, 'deal.complete': 1 },
      byOutcome: { ok: 2, error: 1 },
    };
  }
}

interface StubQueueTask {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextRunAt: string;
}

interface StubQueueConfig {
  stats: { pending: number; dead: number; total: number; processing?: number };
  tasks?: StubQueueTask[];
}

/** Stand-in for @pkh/plugin-retry-queue, which this package must not depend on. */
class StubRetryQueueService extends Service {
  static provide = 'retryQueue';

  private readonly config: StubQueueConfig;

  constructor(ctx: Context, config: StubQueueConfig) {
    super(ctx, 'retryQueue');
    this.config = config;
  }

  public getStats(): { pending: number; dead: number; total: number; processing?: number } {
    return this.config.stats;
  }

  public list(): StubQueueTask[] {
    return this.config.tasks ?? [];
  }
}

interface BootOptions {
  token?: string;
  audit?: StubAuditConfig;
  retryQueue?: StubQueueConfig;
}

async function waitForDashboard(ctx: Context): Promise<WebDashboardService> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const dashboard = ctx.get('webDashboard', false);
    if (dashboard?.address) return dashboard;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('webDashboard did not start within 1s');
}

async function bootDashboard(options: BootOptions = {}): Promise<Harness> {
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: makeTempDir() });
  await ctx.use(PlayerokService, {
    transport: new MockPlayerokTransport(),
    enableMaintenanceLoops: false,
  });
  await ctx.use(PluginManagerService, {});
  if (options.audit !== undefined) await ctx.use(StubAuditService, options.audit);
  if (options.retryQueue !== undefined) await ctx.use(StubRetryQueueService, options.retryQueue);

  const token = options.token ?? 'test-token';
  await ctx.use(WebDashboardService, { port: 0, token });

  const dashboard = await waitForDashboard(ctx);
  const address = dashboard.address;
  if (!address) throw new Error('dashboard did not bind to a port');

  return {
    ctx,
    dashboard,
    baseUrl: 'http://127.0.0.1:' + String(address.port),
    token,
  };
}

function authedUrl(harness: Harness, pathname: string): string {
  const separator = pathname.includes('?') ? '&' : '?';
  return harness.baseUrl + pathname + separator + 'token=' + encodeURIComponent(harness.token);
}

function seedCachedOrders(ctx: Context): void {
  ctx.storage.set('cached_orders', {
    'deal-old': {
      id: 'deal-old',
      price: 500,
      status: 'FINISHED',
      date: '2026-11-20T10:00:00.000Z',
      item_id: 'item-old',
      item_name: 'Старый товар',
    },
    'deal-new': {
      id: 'deal-new',
      price: 1500,
      status: 'PAID',
      date: '2026-11-25T08:00:00.000Z',
      item_id: 'item-new',
      item_name: 'Новый товар',
    },
  });
}

const SAMPLE_LINE =
  /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)$/;

interface ExpositionSample {
  name: string;
  labels: string;
  value: number;
}

interface ParsedExposition {
  samples: ExpositionSample[];
  helpCounts: Map<string, number>;
  typeKinds: Map<string, string>;
}

/**
 * Parses the body as Prometheus text exposition 0.0.4 and asserts the format
 * invariants: no NaN/Infinity anywhere, valid sample syntax, exactly one HELP
 * and one TYPE per family, and no HELP without samples.
 */
function parseExposition(body: string): ParsedExposition {
  const samples: ExpositionSample[] = [];
  const helpCounts = new Map<string, number>();
  const typeKinds = new Map<string, string>();

  expect(body.endsWith(LF), 'exposition must end with a newline').toBe(true);
  const lines = body.split(LF);
  expect(lines.pop()).toBe('');

  for (const line of lines) {
    expect(line, 'NaN must never appear: ' + line).not.toContain('NaN');
    expect(line, 'Infinity must never appear: ' + line).not.toContain('Infinity');

    if (line.startsWith('# HELP ')) {
      const rest = line.slice('# HELP '.length);
      const separator = rest.indexOf(' ');
      expect(separator, 'HELP without text: ' + line).toBeGreaterThan(0);
      const name = rest.slice(0, separator);
      const text = rest.slice(separator + 1);
      expect(text.length, 'empty HELP text: ' + line).toBeGreaterThan(0);
      helpCounts.set(name, (helpCounts.get(name) ?? 0) + 1);
      continue;
    }

    if (line.startsWith('# TYPE ')) {
      const parts = line.slice('# TYPE '.length).split(' ');
      expect(parts.length, 'malformed TYPE line: ' + line).toBe(2);
      const name = parts[0] ?? '';
      const kind = parts[1] ?? '';
      expect(typeKinds.has(name), 'duplicate TYPE for ' + name).toBe(false);
      typeKinds.set(name, kind);
      continue;
    }

    const match = SAMPLE_LINE.exec(line);
    expect(match, 'invalid sample line: ' + line).not.toBeNull();
    const raw = match?.[3] ?? '';
    const value = Number(raw);
    expect(Number.isFinite(value), 'non-finite sample value: ' + line).toBe(true);
    samples.push({ name: match?.[1] ?? '', labels: match?.[2] ?? '', value });
  }

  for (const sample of samples) {
    expect(helpCounts.get(sample.name), 'missing HELP for ' + sample.name).toBe(1);
    expect(typeKinds.get(sample.name), 'missing TYPE for ' + sample.name).toBe('gauge');
  }
  for (const name of helpCounts.keys()) {
    expect(
      samples.some((sample) => sample.name === name),
      'HELP without samples: ' + name,
    ).toBe(true);
  }

  return { samples, helpCounts, typeKinds };
}

async function scrape(harness: Harness): Promise<string> {
  const response = await fetch(authedUrl(harness, '/metrics'));
  expect(response.status).toBe(200);
  return response.text();
}

const AUDIT_ROWS = [
  {
    at: '2026-11-25T08:00:00.000Z',
    action: 'deal.deliver',
    outcome: 'ok',
    title: '<script>alert(1)</script>',
  },
  {
    at: '2026-11-25T09:00:00.000Z',
    action: 'deal.deliver',
    outcome: 'ok',
    title: 'Вторая выдача',
  },
  {
    at: '2026-11-25T09:30:00.000Z',
    action: 'deal.complete',
    outcome: 'error',
    title: 'Ошибка <b>таймаут</b>',
  },
];

interface AuditPayload {
  available: boolean;
  error: string | null;
  entries: Array<{ id: string | null; at: string; action: string; outcome: string; title: string }>;
  total: number;
  limit: number;
  action: string | null;
  actions: string[];
  stats: {
    total: number | null;
    byAction: Array<{ key: string; count: number }>;
    byOutcome: Array<{ key: string; count: number }>;
  } | null;
}

describe('@pkh/plugin-web /metrics', () => {
  it('is behind the same token gate as every other route', async () => {
    const harness = await bootDashboard();

    try {
      const denied = await fetch(harness.baseUrl + '/metrics');
      expect(denied.status).toBe(401);
      expect(await denied.text()).toContain('Требуется токен');

      // A wrong token is not a scrape credential either.
      const wrong = await fetch(harness.baseUrl + '/metrics?token=not-the-token');
      expect(wrong.status).toBe(401);

      const allowed = await fetch(authedUrl(harness, '/metrics'));
      expect(allowed.status).toBe(200);
      const contentType = allowed.headers.get('content-type') ?? '';
      expect(contentType).toContain('text/plain');
      expect(contentType).toContain('version=0.0.4');
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('renders valid exposition text with the required families', async () => {
    const harness = await bootDashboard();
    seedCachedOrders(harness.ctx);

    try {
      const body = await scrape(harness);
      const lines = body.split(LF);
      const parsed = parseExposition(body);

      expect(lines).toContain('pkh_up 1');
      expect(lines).toContain('# TYPE pkh_up gauge');
      expect(lines).toContain('pkh_version{version="1.0.0"} 1');
      expect(lines).toContain('pkh_cached_orders_total 2');
      // 500 + 1500 from the seeded cache.
      expect(lines).toContain('pkh_deals_revenue_rub 2000');
      expect(lines).toContain('pkh_plugins_enabled_total 0');
      expect(lines).toContain('pkh_sse_clients 0');
      expect(lines).toContain('pkh_access_tokens 0');

      // No retry queue mounted: the whole family is omitted, not zeroed.
      expect(lines.some((line) => line.startsWith('pkh_retry_queue_tasks'))).toBe(false);
      expect(parsed.helpCounts.has('pkh_retry_queue_tasks')).toBe(false);

      const uptime = parsed.samples.find((sample) => sample.name === 'pkh_uptime_seconds');
      expect(uptime).toBeDefined();
      expect(uptime?.value).toBeGreaterThanOrEqual(0);

      const resident = parsed.samples.find(
        (sample) => sample.name === 'pkh_process_resident_memory_bytes',
      );
      expect(resident?.value).toBeGreaterThan(0);

      const heap = parsed.samples.find((sample) => sample.name === 'pkh_process_heap_used_bytes');
      expect(heap?.value).toBeGreaterThan(0);

      const lag = parsed.samples.find(
        (sample) => sample.name === 'pkh_nodejs_eventloop_lag_seconds',
      );
      expect(lag).toBeDefined();
      expect(lag?.value).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(lag?.value)).toBe(true);
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('reports every retry-queue status when the queue is mounted', async () => {
    const harness = await bootDashboard({
      retryQueue: { stats: { pending: 3, processing: 1, dead: 2, total: 6 } },
    });

    try {
      const body = await scrape(harness);
      const lines = body.split(LF);
      parseExposition(body);

      expect(lines).toContain('pkh_retry_queue_tasks{status="pending"} 3');
      expect(lines).toContain('pkh_retry_queue_tasks{status="processing"} 1');
      expect(lines).toContain('pkh_retry_queue_tasks{status="dead"} 2');
      // Exactly one HELP/TYPE pair for the labelled family.
      expect(body.split('# HELP pkh_retry_queue_tasks ').length).toBe(2);
      expect(body.split('# TYPE pkh_retry_queue_tasks ').length).toBe(2);
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('derives the processing count from list() when stats() omits it', async () => {
    const harness = await bootDashboard({
      retryQueue: {
        stats: { pending: 2, dead: 1, total: 4 },
        tasks: [
          {
            id: 't-1',
            kind: 'send_message',
            status: 'processing',
            attempts: 1,
            maxAttempts: 5,
            nextRunAt: '2026-11-25T09:00:00.000Z',
          },
          {
            id: 't-2',
            kind: 'send_message',
            status: 'pending',
            attempts: 1,
            maxAttempts: 5,
            nextRunAt: '2026-11-25T09:01:00.000Z',
          },
        ],
      },
    });

    try {
      const lines = (await scrape(harness)).split(LF);
      expect(lines).toContain('pkh_retry_queue_tasks{status="processing"} 1');
      expect(lines).toContain('pkh_retry_queue_tasks{status="pending"} 2');
      expect(lines).toContain('pkh_retry_queue_tasks{status="dead"} 1');
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('reflects live SSE clients and minted access tokens', async () => {
    const harness = await bootDashboard();

    try {
      harness.dashboard.mintAccessToken();
      harness.dashboard.mintAccessToken();

      const sse = await fetch(authedUrl(harness, '/events'));
      expect(sse.status).toBe(200);
      const reader = sse.body?.getReader();
      if (!reader) throw new Error('SSE response has no body');
      // The greeting is written after the stream is registered.
      await reader.read();

      try {
        const lines = (await scrape(harness)).split(LF);
        expect(lines).toContain('pkh_sse_clients 1');
        expect(lines).toContain('pkh_access_tokens 2');
      } finally {
        await reader.cancel().catch(() => {});
      }
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });
});

describe('@pkh/plugin-web /audit', () => {
  it('serves newest-first entries on /api/audit with filter and limit', async () => {
    const harness = await bootDashboard({ audit: { rows: AUDIT_ROWS } });

    try {
      const all = (await (await fetch(authedUrl(harness, '/api/audit'))).json()) as AuditPayload;
      expect(all.available).toBe(true);
      expect(all.error).toBeNull();
      expect(all.total).toBe(3);
      expect(all.limit).toBe(50);
      expect(all.action).toBeNull();
      // Newest first, by parsed timestamp.
      expect(all.entries.map((entry) => entry.at)).toEqual([
        '2026-11-25T09:30:00.000Z',
        '2026-11-25T09:00:00.000Z',
        '2026-11-25T08:00:00.000Z',
      ]);
      expect(all.entries.map((entry) => entry.action)).toEqual([
        'deal.complete',
        'deal.deliver',
        'deal.deliver',
      ]);
      expect(all.actions).toEqual(['deal.complete', 'deal.deliver']);

      const limited = (await (
        await fetch(authedUrl(harness, '/api/audit?limit=1'))
      ).json()) as AuditPayload;
      expect(limited.entries.length).toBe(1);
      expect(limited.total).toBe(3);
      expect(limited.limit).toBe(1);

      const filtered = (await (
        await fetch(authedUrl(harness, '/api/audit?action=deal.deliver'))
      ).json()) as AuditPayload;
      expect(filtered.action).toBe('deal.deliver');
      expect(filtered.total).toBe(2);
      expect(filtered.entries.every((entry) => entry.action === 'deal.deliver')).toBe(true);

      // Counters from stats() are normalised, not passed through raw.
      expect(all.stats?.total).toBe(3);
      expect(all.stats?.byAction[0]).toEqual({ key: 'deal.deliver', count: 2 });
      expect(all.stats?.byOutcome[0]).toEqual({ key: 'ok', count: 2 });
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('renders the audit page newest first with everything escaped', async () => {
    const harness = await bootDashboard({ audit: { rows: AUDIT_ROWS } });

    try {
      const response = await fetch(authedUrl(harness, '/audit'));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') ?? '').toContain('text/html');
      const html = await response.text();

      expect(html).toContain('Журнал аудита');
      expect(html).toContain('Показано 3 из 3');
      expect(html).toContain('всего записей: 3');
      expect(html).toContain('deal.complete');

      // User data never reaches the markup unescaped.
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('Ошибка &lt;b&gt;таймаут&lt;/b&gt;');
      expect(html).not.toContain('<b>таймаут</b>');

      // Newest first in the table too.
      expect(html.indexOf('Ошибка &lt;b&gt;таймаут&lt;/b&gt;')).toBeLessThan(
        html.indexOf('Вторая выдача'),
      );
      expect(html.indexOf('Вторая выдача')).toBeLessThan(
        html.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;'),
      );

      // The optional service is present, so no "not mounted" explanation.
      expect(html).not.toContain('Служба аудита не подключена');
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('explains the missing service on both the page and the API', async () => {
    const harness = await bootDashboard();

    try {
      const page = await fetch(authedUrl(harness, '/audit'));
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('Служба аудита не подключена');
      expect(html).toContain('Журнал аудита');

      const api = await fetch(authedUrl(harness, '/api/audit'));
      expect(api.status).toBe(200);
      const payload = (await api.json()) as AuditPayload;
      expect(payload.available).toBe(false);
      expect(payload.error).toBeNull();
      expect(payload.entries).toEqual([]);
      expect(payload.total).toBe(0);
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('keeps rendering when the audit service throws', async () => {
    const harness = await bootDashboard({ audit: { error: 'boom' } });

    try {
      const page = await fetch(authedUrl(harness, '/audit'));
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('Не удалось прочитать журнал: boom');
      expect(html).toContain('Записей нет');

      const payload = (await (await fetch(authedUrl(harness, '/api/audit'))).json()) as AuditPayload;
      expect(payload.available).toBe(true);
      expect(payload.error).toContain('boom');
      expect(payload.entries).toEqual([]);
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });
});

describe('@pkh/plugin-web navigation', () => {
  it('lists the audit page and the metrics endpoint on every page', async () => {
    const harness = await bootDashboard();

    try {
      for (const pathname of ['/', '/logs', '/queue', '/audit']) {
        const response = await fetch(authedUrl(harness, pathname));
        expect(response.status, pathname).toBe(200);
        const html = await response.text();

        expect(html, pathname).toContain('href="/audit"');
        expect(html, pathname).toContain('href="/metrics"');
        expect(html, pathname).toContain('Аудит');
        expect(html, pathname).toContain('Метрики');
        // The endpoint list is part of the shared layout, not just the overview.
        expect(html, pathname).toContain('/api/audit');
        expect(html, pathname).toContain('метрики Prometheus');
      }
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });
});

describe('@pkh/plugin-web Prometheus escaping', () => {
  it('escapes backslashes, quotes and newlines in label values', () => {
    expect(escapePrometheusLabelValue('plain')).toBe('plain');
    expect(escapePrometheusLabelValue('"')).toBe(BACKSLASH + '"');
    expect(escapePrometheusLabelValue(LF)).toBe(BACKSLASH + 'n');
    expect(escapePrometheusLabelValue(BACKSLASH)).toBe(BACKSLASH + BACKSLASH);

    const input = 'a"b' + BACKSLASH + 'c' + LF + 'd';
    const expected = 'a' + BACKSLASH + '"b' + BACKSLASH + BACKSLASH + 'c' + BACKSLASH + 'n' + 'd';
    expect(escapePrometheusLabelValue(input)).toBe(expected);
  });
});
