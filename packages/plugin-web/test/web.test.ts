import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Context, LogSinkService, PluginManagerService, StorageService } from '@pkh/core';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import {
  escapeHtml,
  renderQueue,
  startOfLocalDay,
  WebDashboardService,
  webDashboardPlugin,
} from '@pkh/plugin-web';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-web-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  ctx: Context;
  dashboard: WebDashboardService;
  baseUrl: string;
  port: number;
  token: string;
}

function authedUrl(harness: Harness, pathname: string): string {
  return `${harness.baseUrl}${pathname}?token=${encodeURIComponent(harness.token)}`;
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 4000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function waitForDashboard(ctx: Context): Promise<WebDashboardService> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const dashboard = ctx.get('webDashboard', false);
    if (dashboard?.address) return dashboard;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('webDashboard did not start within 1s');
}

async function bootDashboard(
  token = 'test-token',
  options: { logSink?: boolean; heartbeatMs?: number } = {},
): Promise<Harness> {
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: makeTempDir() });
  await ctx.use(PlayerokService, {
    transport: new MockPlayerokTransport(),
    enableMaintenanceLoops: false,
  });
  // WebDashboardService.inject requires the plugin manager even when no external
  // plugins are installed, so mount it before the dashboard.
  await ctx.use(PluginManagerService, {});
  if (options.logSink) {
    await ctx.use(LogSinkService, { silentConsole: true });
  }
  await ctx.use(WebDashboardService, { port: 0, token, heartbeatMs: options.heartbeatMs });

  const dashboard = await waitForDashboard(ctx);
  const address = dashboard.address;
  if (!address) throw new Error('dashboard did not bind to a port');

  return {
    ctx,
    dashboard,
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    token,
  };
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
      item_name: 'Steam <script>alert(1)</script>',
    },
  });
}

describe('@pkh/plugin-web', () => {
  it('rejects anonymous requests with 401 and renders data with a token', async () => {
    const harness = await bootDashboard();
    seedCachedOrders(harness.ctx);

    try {
      const denied = await fetch(`${harness.baseUrl}/`);
      expect(denied.status).toBe(401);
      expect(await denied.text()).toContain('Требуется токен');

      const wrongToken = await fetch(`${harness.baseUrl}/?token=not-the-token`);
      expect(wrongToken.status).toBe(401);

      const allowed = await fetch(authedUrl(harness, '/'));
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('content-type')).toContain('text/html');

      const setCookie = allowed.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('pkh_web_token=');
      expect(setCookie).toContain('HttpOnly');

      const html = await allowed.text();
      expect(html).toContain('DemoSeller');
      expect(html).toContain('Очередь повторов');
      expect(html).toContain('/api/status');

      // The cookie obtained from ?token= authenticates follow-up requests.
      const viaCookie = await fetch(`${harness.baseUrl}/api/status`, {
        headers: { cookie: `pkh_web_token=${encodeURIComponent(harness.token)}` },
      });
      expect(viaCookie.status).toBe(200);

      // /healthz stays public so uptime probes work without a token.
      const health = await fetch(`${harness.baseUrl}/healthz`);
      expect(health.status).toBe(200);
      const healthJson = (await health.json()) as { ok: boolean; uptime: number; version: string };
      expect(healthJson.ok).toBe(true);
      expect(healthJson.version).toBe('1.0.0');
      expect(typeof healthJson.uptime).toBe('number');

      // Optional services stay absent: the pages explain that instead of failing.
      const logs = await fetch(authedUrl(harness, '/logs'));
      expect(logs.status).toBe(200);
      expect(await logs.text()).toContain('Источник логов не подключён');

      const queue = await fetch(authedUrl(harness, '/queue'));
      expect(queue.status).toBe(200);
      expect(await queue.text()).toContain('Служба очереди повторов не подключена');
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('mints a single-use, session-scoped access token', async () => {
    const harness = await bootDashboard();

    try {
      const minted = harness.dashboard.mintAccessToken();
      expect(minted).toBeTruthy();
      const mintedUrl = `${harness.baseUrl}/api/status?token=${encodeURIComponent(minted ?? '')}`;

      const first = await fetch(mintedUrl);
      expect(first.status).toBe(200);
      // Same credential, but a session cookie: no Max-Age, so it dies with the browser.
      const cookie = first.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('pkh_web_token=');
      expect(cookie).not.toContain('Max-Age');

      // Single use: the very same link is rejected the second time.
      const second = await fetch(mintedUrl);
      expect(second.status).toBe(401);
      expect(await second.text()).toContain('Требуется токен');

      // The shared long-lived token is untouched by the consumption above.
      const shared = await fetch(authedUrl(harness, '/api/status'));
      expect(shared.status).toBe(200);
      expect(shared.headers.get('set-cookie') ?? '').toContain('Max-Age=604800');

      // The session cookie keeps navigation working after the one-time token is gone.
      const viaCookie = await fetch(`${harness.baseUrl}/deals`, {
        headers: { cookie: `pkh_web_token=${encodeURIComponent(harness.token)}` },
      });
      expect(viaCookie.status).toBe(200);
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('rejects an expired minted token', async () => {
    const harness = await bootDashboard();

    try {
      const expired = harness.dashboard.mintAccessToken(1);
      expect(expired).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 30));

      const response = await fetch(
        `${harness.baseUrl}/api/status?token=${encodeURIComponent(expired ?? '')}`,
      );
      expect(response.status).toBe(401);
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('bounds the minted-token map at 50 entries and evicts the oldest', async () => {
    const harness = await bootDashboard();

    try {
      const minted: string[] = [];
      for (let index = 0; index < 60; index += 1) {
        const token = harness.dashboard.mintAccessToken();
        expect(token).toBeTruthy();
        minted.push(token ?? '');
      }
      expect(harness.dashboard.accessTokenCount).toBeLessThanOrEqual(50);

      // The oldest entries were evicted, so their links no longer authenticate.
      const evicted = await fetch(
        `${harness.baseUrl}/api/status?token=${encodeURIComponent(minted[0] ?? '')}`,
      );
      expect(evicted.status).toBe(401);

      // The newest one still works exactly once.
      const newestUrl = `${harness.baseUrl}/api/status?token=${encodeURIComponent(minted[minted.length - 1] ?? '')}`;
      expect((await fetch(newestUrl)).status).toBe(200);
      expect((await fetch(newestUrl)).status).toBe(401);

      // And the shared token was never affected by the cap.
      expect((await fetch(authedUrl(harness, '/api/status'))).status).toBe(200);
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('returns the overview as JSON on /api/status', async () => {
    const harness = await bootDashboard();
    seedCachedOrders(harness.ctx);

    try {
      const response = await fetch(authedUrl(harness, '/api/status'));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');

      const status = (await response.json()) as {
        ok: boolean;
        version: string;
        uptimeSeconds: number;
        account: { username: string } | null;
        cachedOrders: number;
        queue: unknown;
        plugins: { enabled: number; total: number };
        bootErrors: unknown[];
      };

      expect(status.ok).toBe(true);
      expect(status.version).toBe('1.0.0');
      expect(typeof status.uptimeSeconds).toBe('number');
      expect(status.account?.username).toBe('DemoSeller');
      expect(status.cachedOrders).toBe(2);
      expect(status.queue).toBeNull();
      expect(status.plugins).toEqual({ enabled: 0, total: 0 });
      expect(status.bootErrors).toEqual([]);
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('renders cached deals newest first and escapes user data', async () => {
    const harness = await bootDashboard();
    seedCachedOrders(harness.ctx);

    try {
      const response = await fetch(authedUrl(harness, '/deals'));
      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).toContain('Steam &lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html.indexOf('deal-new')).toBeLessThan(html.indexOf('deal-old'));

      const jsonResponse = await fetch(authedUrl(harness, '/api/deals'));
      const data = (await jsonResponse.json()) as {
        total: number;
        deals: Array<{ id: string; itemName: string }>;
      };
      expect(data.total).toBe(2);
      expect(data.deals.map((deal) => deal.id)).toEqual(['deal-new', 'deal-old']);
      expect(data.deals[0]?.itemName).toBe('Steam <script>alert(1)</script>');

      const queueResponse = await fetch(authedUrl(harness, '/api/queue'));
      expect(await queueResponse.json()).toEqual({ stats: null, tasks: [] });
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('delivers a retry/enqueued event to SSE clients', async () => {
    const harness = await bootDashboard();

    try {
      const response = await fetch(authedUrl(harness, '/events'));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = response.body?.getReader();
      if (!reader) throw new Error('SSE response has no body');
      const decoder = new TextDecoder();
      let buffer = '';

      const readUntil = async (predicate: (text: string) => boolean): Promise<void> => {
        while (!predicate(buffer)) {
          const chunk = await withTimeout(reader.read(), 'SSE read');
          if (chunk.done) throw new Error('SSE stream ended before the expected frame');
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      };

      // The server writes this greeting only after the client is registered.
      await readUntil((text) => text.includes(': connected'));

      const bus = harness.ctx as unknown as {
        parallel(name: string, payload: Record<string, unknown>): Promise<void>;
      };
      await bus.parallel('retry/enqueued', {
        id: 'task-1',
        kind: 'send_message',
        status: 'pending',
        attempts: 1,
        maxAttempts: 5,
        nextRunAt: '2026-11-25T08:45:00.000Z',
        createdAt: '2026-11-25T08:40:00.000Z',
        payload: {},
      });

      await readUntil((text) => text.includes('data: '));
      const frame = buffer.split('\n').find((line) => line.startsWith('data: '));
      expect(frame).toBeDefined();

      const envelope = JSON.parse((frame ?? '').slice('data: '.length)) as {
        event: string;
        data: { id: string; kind: string };
      };
      expect(envelope.event).toBe('retry/enqueued');
      expect(envelope.data.id).toBe('task-1');
      expect(envelope.data.kind).toBe('send_message');

      await reader.cancel();
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('closes the server, SSE streams and frees the port on dispose', async () => {
    const harness = await bootDashboard();

    const response = await fetch(authedUrl(harness, '/events'));
    const reader = response.body?.getReader();
    if (!reader) throw new Error('SSE response has no body');
    await withTimeout(reader.read(), 'SSE greeting');

    expect((await fetch(`${harness.baseUrl}/healthz`)).status).toBe(200);

    await harness.ctx.fiber.dispose();

    expect(harness.dashboard.address).toBeNull();

    let streamClosed = false;
    for (let attempt = 0; attempt < 5 && !streamClosed; attempt += 1) {
      streamClosed = await withTimeout(
        reader.read().then((chunk) => chunk.done ?? false).catch(() => true),
        'SSE close after dispose',
      );
    }
    expect(streamClosed).toBe(true);

    // A disposed dashboard no longer answers; the OS refuses the connection.
    await expect(fetch(`${harness.baseUrl}/healthz`)).rejects.toThrow();

    // Port is really free: a fresh listener can bind it again.
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(harness.port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  it('refuses a non-loopback host without a token', async () => {
    const savedToken = process.env.PKH_WEB_TOKEN;
    delete process.env.PKH_WEB_TOKEN;

    try {
      const ctx = new Context();
      expect(() => new WebDashboardService(ctx, { host: '0.0.0.0', port: 0 })).toThrow(/токен/i);
      await ctx.fiber.dispose();
    } finally {
      if (savedToken === undefined) delete process.env.PKH_WEB_TOKEN;
      else process.env.PKH_WEB_TOKEN = savedToken;
    }
  });

  it('is importable as a plain Cordis component', async () => {
    expect(webDashboardPlugin.name).toBe('pkh:web');
    expect(webDashboardPlugin.inject).toEqual(['storage']);
    expect(typeof webDashboardPlugin.apply).toBe('function');

    const ctx = new Context();
    try {
      await ctx.use(StorageService, { baseDir: makeTempDir() });
      await ctx.use(PlayerokService, {
        transport: new MockPlayerokTransport(),
        enableMaintenanceLoops: false,
      });
      await ctx.use(PluginManagerService, {});
      await ctx.use(webDashboardPlugin, { port: 0, token: 'component-token' });

      const dashboard = await waitForDashboard(ctx);
      const port = dashboard.address?.port;
      expect(port).toBeGreaterThan(0);

      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('caps the deals page at the newest 100 cached orders', async () => {
    const harness = await bootDashboard();
    const cached: Record<string, unknown> = {};
    for (let index = 0; index < 105; index += 1) {
      const id = `deal-${String(index).padStart(3, '0')}`;
      const minute = String(59 - (index % 60)).padStart(2, '0');
      cached[id] = {
        id,
        price: 100 + index,
        status: 'PAID',
        date: `2026-11-25T08:${minute}:00.000Z`,
        item_id: `item-${index}`,
        item_name: `Товар ${index}`,
      };
    }
    harness.ctx.storage.set('cached_orders', cached);

    try {
      const response = await fetch(authedUrl(harness, '/api/deals'));
      const data = (await response.json()) as {
        total: number;
        deals: Array<{ id: string }>;
      };
      expect(data.total).toBe(105);
      expect(data.deals.length).toBe(100);

      const html = await (await fetch(authedUrl(harness, '/deals'))).text();
      expect(html).toContain('100 из 105');
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('shows recent log lines on /logs when a log sink is mounted', async () => {
    const harness = await bootDashboard('test-token', { logSink: true });

    try {
      harness.ctx.logger('web-test').info('MARKER-LOG-LINE');
      const response = await fetch(authedUrl(harness, '/logs'));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('MARKER-LOG-LINE');
      expect(html).toContain('Последние 200 строк');
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('renders retry tasks with attempts, last error and next run time', () => {
    const html = renderQueue({
      stats: { pending: 1, dead: 1, total: 2 },
      tasks: [
        {
          id: 'task-a',
          kind: 'update_deal',
          status: 'pending',
          attempts: 2,
          maxAttempts: 5,
          lastError: 'HTTP 503 <b>',
          nextRunAt: '2026-11-25T09:00:00.000Z',
        },
        {
          id: 'task-b',
          kind: 'send_message',
          status: 'dead',
          attempts: 5,
          maxAttempts: 5,
          lastError: 'ECONNRESET',
          nextRunAt: '2026-11-25T08:00:00.000Z',
        },
      ],
    });

    expect(html).toContain('update_deal');
    expect(html).toContain('2 / 5');
    expect(html).toContain('HTTP 503 &lt;b&gt;');
    expect(html).toContain('2026-11-25T09:00:00.000Z');
    expect(html).toContain('dead: 1');
  });

  it('reads the access token from PKH_WEB_TOKEN when the config omits it', async () => {
    const savedToken = process.env.PKH_WEB_TOKEN;
    process.env.PKH_WEB_TOKEN = 'env-token';

    const ctx = new Context();
    try {
      await ctx.use(StorageService, { baseDir: makeTempDir() });
      await ctx.use(PlayerokService, {
        transport: new MockPlayerokTransport(),
        enableMaintenanceLoops: false,
      });
      await ctx.use(PluginManagerService, {});
      await ctx.use(WebDashboardService, { port: 0 });

      const dashboard = await waitForDashboard(ctx);
      const port = dashboard.address?.port;
      expect(port).toBeGreaterThan(0);

      const baseUrl = 'http://127.0.0.1:' + String(port);
      const denied = await fetch(baseUrl + '/api/status');
      expect(denied.status).toBe(401);

      const allowed = await fetch(baseUrl + '/api/status?token=env-token');
      expect(allowed.status).toBe(200);
    } finally {
      if (savedToken === undefined) delete process.env.PKH_WEB_TOKEN;
      else process.env.PKH_WEB_TOKEN = savedToken;
      await ctx.fiber.dispose();
    }
  });

  it('stays mounted without a socket when disabled', async () => {
    const ctx = new Context();
    try {
      await ctx.use(StorageService, { baseDir: makeTempDir() });
      await ctx.use(PlayerokService, {
        transport: new MockPlayerokTransport(),
        enableMaintenanceLoops: false,
      });
      await ctx.use(PluginManagerService, {});
      await ctx.use(WebDashboardService, { enabled: false, port: 0, token: 'unused' });

      const dashboard = ctx.get('webDashboard', false);
      expect(dashboard).toBeDefined();
      expect(dashboard?.address).toBeNull();
      // Nothing to mint while the dashboard is disabled.
      expect(dashboard?.mintAccessToken()).toBeNull();
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('escapes tags, quotes and empty values', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
    expect(escapeHtml("'")).toBe('&#39;');
    expect(escapeHtml(null)).toBe('');
  });
});

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface AnalyticsTotalsPayload {
  revenue: number;
  orders: number;
  averageOrderValue: number | null;
}

interface AnalyticsPayload {
  generatedAt: string;
  cachedOrders: number;
  today: AnalyticsTotalsPayload;
  last7Days: AnalyticsTotalsPayload;
  last30Days: AnalyticsTotalsPayload;
  allTime: AnalyticsTotalsPayload;
  topItems: Array<{ itemId: string; itemName: string; revenue: number; orders: number }>;
}

/**
 * Seeds a cache whose analytics windows are stable relative to Date.now():
 * the "today" anchors sit at least a minute after local midnight and never
 * later than noon, so the numbers below cannot straddle a day boundary.
 */
function seedAnalyticsOrders(ctx: Context): void {
  const now = Date.now();
  const startOfToday = startOfLocalDay(now);
  const todayAnchor = Math.min(startOfToday + 12 * HOUR_MS, Math.max(now, startOfToday + 60_000));
  const at = (offsetMs: number): string => new Date(todayAnchor + offsetMs).toISOString();

  const seeds: Array<{ id: string; price: number; date: string; itemId: string; itemName: string }> =
    [
      { id: 'an-today-a', price: 1000, date: at(0), itemId: 'item-a', itemName: 'Товар A' },
      { id: 'an-today-b', price: 500, date: at(-60_000), itemId: 'item-b', itemName: 'Товар B' },
      { id: 'an-week', price: 250, date: at(-2 * DAY_MS), itemId: 'item-c', itemName: 'Товар C' },
      { id: 'an-month', price: 100, date: at(-20 * DAY_MS), itemId: 'item-a', itemName: 'Товар A' },
      { id: 'an-old', price: 50, date: at(-100 * DAY_MS), itemId: 'item-e', itemName: 'Товар E' },
      {
        id: 'an-older',
        price: 20,
        date: at(-110 * DAY_MS),
        itemId: 'item-f',
        itemName: 'Товар <i>F</i>',
      },
      {
        id: 'an-oldest',
        price: 10,
        date: at(-120 * DAY_MS),
        itemId: 'item-g',
        itemName: 'Товар G',
      },
    ];

  const cached: Record<string, unknown> = {};
  for (const seed of seeds) {
    cached[seed.id] = {
      id: seed.id,
      price: seed.price,
      status: 'FINISHED',
      date: seed.date,
      item_id: seed.itemId,
      item_name: seed.itemName,
    };
  }
  ctx.storage.set('cached_orders', cached);
}

interface SseStream {
  text(): string;
  readUntil(
    predicate: (text: string) => boolean,
    label?: string,
    timeoutMs?: number,
  ): Promise<string>;
  close(): Promise<void>;
}

function openSse(response: Response): SseStream {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('SSE response has no body');
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    text: () => buffer,
    async readUntil(predicate, label = 'SSE read', timeoutMs = 4000) {
      while (!predicate(buffer)) {
        const chunk = await withTimeout(reader.read(), label, timeoutMs);
        if (chunk.done) throw new Error(`SSE stream ended while waiting for ${label}`);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      return buffer;
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

interface EventBus {
  parallel(name: string, payload: Record<string, unknown>): Promise<void>;
}

async function publishRetryEvent(ctx: Context, id: string): Promise<void> {
  const bus = ctx as unknown as EventBus;
  await bus.parallel('retry/enqueued', {
    id,
    kind: 'send_message',
    status: 'pending',
    attempts: 1,
    maxAttempts: 5,
    nextRunAt: '2026-11-25T08:45:00.000Z',
    createdAt: '2026-11-25T08:40:00.000Z',
    payload: {},
  });
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('@pkh/plugin-web analytics', () => {
  it('aggregates cached orders into today / 7d / 30d / all-time windows', async () => {
    const harness = await bootDashboard();
    seedAnalyticsOrders(harness.ctx);

    try {
      const response = await fetch(authedUrl(harness, '/api/analytics'));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');

      const data = (await response.json()) as AnalyticsPayload;
      expect(data.cachedOrders).toBe(7);
      expect(data.today).toEqual({ revenue: 1500, orders: 2, averageOrderValue: 750 });
      expect(data.last7Days).toEqual({ revenue: 1750, orders: 3, averageOrderValue: 583.33 });
      expect(data.last30Days).toEqual({ revenue: 1850, orders: 4, averageOrderValue: 462.5 });
      expect(data.allTime).toEqual({ revenue: 1930, orders: 7, averageOrderValue: 275.71 });

      // Top five only: item-g is the smallest item and must be cut off.
      expect(data.topItems.length).toBe(5);
      expect(data.topItems.map((item) => item.itemId)).toEqual([
        'item-a',
        'item-b',
        'item-c',
        'item-e',
        'item-f',
      ]);
      expect(data.topItems[0]).toEqual({
        itemId: 'item-a',
        itemName: 'Товар A',
        revenue: 1100,
        orders: 2,
      });
      expect(data.topItems.some((item) => item.itemId === 'item-g')).toBe(false);
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('renders the analytics page with a table and bars but never NaN', async () => {
    const harness = await bootDashboard();
    seedAnalyticsOrders(harness.ctx);

    try {
      const response = await fetch(authedUrl(harness, '/analytics'));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');

      const html = await response.text();
      expect(html).not.toContain('NaN');
      expect(html).toContain('Выручка по периодам');
      expect(html).toContain('1500.00');
      expect(html).toContain('1930.00');
      expect(html).toContain('583.33');
      expect(html).toContain('Товар A');
      expect(html).toContain('<ul class="bars">');
      // item-a is the revenue leader, so its bar spans the full track.
      expect(html).toContain('width:100%');
      // Item names in the bar list are HTML-escaped too.
      expect(html).toContain('Товар &lt;i&gt;F&lt;/i&gt;');
      expect(html).not.toContain('<i>F</i>');
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('shows "нет данных" instead of NaN when the order cache is empty', async () => {
    const harness = await bootDashboard();

    try {
      const json = await fetch(authedUrl(harness, '/api/analytics'));
      const data = (await json.json()) as AnalyticsPayload;
      expect(data.cachedOrders).toBe(0);
      expect(data.today).toEqual({ revenue: 0, orders: 0, averageOrderValue: null });
      expect(data.last7Days.averageOrderValue).toBeNull();
      expect(data.last30Days.averageOrderValue).toBeNull();
      expect(data.allTime).toEqual({ revenue: 0, orders: 0, averageOrderValue: null });
      expect(data.topItems).toEqual([]);

      const html = await (await fetch(authedUrl(harness, '/analytics'))).text();
      expect(html).not.toContain('NaN');
      expect(html).toContain('Кэш сделок пуст');
      expect(html).toContain('нет данных');
      expect(html).toContain('0.00 ₽');
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });
});

describe('@pkh/plugin-web SSE resilience', () => {
  it('writes ids on every frame and replays only newer buffered events', async () => {
    const harness = await bootDashboard();

    try {
      // Published with no client attached: frames must still land in the buffer.
      await publishRetryEvent(harness.ctx, 'evt-1');
      await publishRetryEvent(harness.ctx, 'evt-2');
      await publishRetryEvent(harness.ctx, 'evt-3');

      expect(harness.dashboard.lastEventId).toBe(3);
      expect(harness.dashboard.bufferedEvents.map((frame) => frame.id)).toEqual([1, 2, 3]);

      // ?lastEventId=2 must replay id 3 only, with the id line written first.
      const resumed = openSse(
        await fetch(`${authedUrl(harness, '/events')}&lastEventId=2`),
      );
      try {
        await resumed.readUntil((text) => text.includes('evt-3'), 'replayed frame');
        expect(resumed.text()).toContain('id: 3');
        expect(resumed.text()).not.toContain('evt-2');
        expect(resumed.text()).not.toContain('evt-1');

        // The Last-Event-ID header with id 0 replays the whole buffer.
        const headerResumed = openSse(
          await fetch(authedUrl(harness, '/events'), { headers: { 'last-event-id': '0' } }),
        );
        try {
          await headerResumed.readUntil((text) => text.includes('evt-3'), 'header replay');
          expect(headerResumed.text()).toContain('id: 1');
          expect(headerResumed.text()).toContain('evt-1');
          expect(headerResumed.text()).toContain('evt-2');

          // Live frames continue the sequence for every attached client.
          await publishRetryEvent(harness.ctx, 'evt-live');
          await resumed.readUntil((text) => text.includes('evt-live'), 'live frame');
          await headerResumed.readUntil((text) => text.includes('evt-live'), 'live frame (header)');
          expect(resumed.text()).toContain('id: 4');
          expect(headerResumed.text()).toContain('id: 4');

          // A client without Last-Event-ID starts live and gets no history.
          const fresh = openSse(await fetch(authedUrl(harness, '/events')));
          try {
            await fresh.readUntil((text) => text.includes(': connected'), 'fresh greeting');
            expect(fresh.text()).not.toContain('evt-');
          } finally {
            await fresh.close();
          }
        } finally {
          await headerResumed.close();
        }
      } finally {
        await resumed.close();
      }
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('caps the replay buffer at 200 frames', async () => {
    const harness = await bootDashboard();

    try {
      for (let index = 1; index <= 205; index += 1) {
        await publishRetryEvent(harness.ctx, `evt-${index}`);
      }

      const buffered = harness.dashboard.bufferedEvents;
      expect(buffered.length).toBe(200);
      expect(buffered[0]?.id).toBe(6);
      expect(buffered[buffered.length - 1]?.id).toBe(205);
      expect(harness.dashboard.lastEventId).toBe(205);
    } finally {
      await harness.ctx.fiber.dispose();
    }
  });

  it('pings streams, clears timers on client close and on dispose, and disposes twice safely', async () => {
    const harness = await bootDashboard('test-token', { heartbeatMs: 40 });

    const first = openSse(await fetch(authedUrl(harness, '/events')));
    const second = openSse(await fetch(authedUrl(harness, '/events')));

    try {
      await first.readUntil((text) => text.includes(': ping'), 'SSE heartbeat', 3000);
      expect(harness.dashboard.openStreams).toBe(2);
      expect(harness.dashboard.heartbeatTimers).toBe(2);

      // A closed client drops its stream and its keep-alive timer.
      await first.close();
      await waitFor(
        () => harness.dashboard.openStreams === 1 && harness.dashboard.heartbeatTimers === 1,
        'client-close cleanup',
      );

      await harness.ctx.fiber.dispose();
      expect(harness.dashboard.address).toBeNull();
      expect(harness.dashboard.openStreams).toBe(0);
      expect(harness.dashboard.heartbeatTimers).toBe(0);

      // Second dispose is a no-op: no throw, no revived socket or timer.
      await expect(harness.ctx.fiber.dispose()).resolves.toBeUndefined();
      expect(harness.dashboard.address).toBeNull();
      expect(harness.dashboard.openStreams).toBe(0);
      expect(harness.dashboard.heartbeatTimers).toBe(0);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

