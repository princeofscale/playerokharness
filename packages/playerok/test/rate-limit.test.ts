import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { Context, StorageService } from '@pkh/core';
import {
  BotCheckDetectedError,
  GraphQLPlayerokTransport,
  MockPlayerokTransport,
  PlayerokService,
  RateLimitClosedError,
  RateLimitTimeoutError,
  TokenBucket,
  UnauthorizedError,
  type GraphQLTransportOptions,
} from '@pkh/adapter';

type ServerMode = 'ok' | 'cf' | 'unauth' | 'graphql-error';

interface TestServer {
  baseUrl: string;
  wsUrl: string;
  hits: Array<{ method: string; op?: string }>;
  readonly maxConcurrency: number;
  setMode(mode: ServerMode): void;
  setDelayMs(ms: number): void;
  close(): Promise<void>;
}

/**
 * Minimal PlayerOK stand-in on 127.0.0.1: answers GraphQL POST/GET requests,
 * tracks concurrency and can switch into the failure modes the counters must
 * classify. A WS server on the same port acks `connection_init`.
 */
async function createTestServer(): Promise<TestServer> {
  const state = { mode: 'ok' as ServerMode, delayMs: 0, inFlight: 0, maxConcurrency: 0 };
  const hits: TestServer['hits'] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      let op = urlObj.searchParams.get('operationName') || undefined;
      if (!op && body.startsWith('{')) {
        try {
          op = (JSON.parse(body) as { operationName?: string }).operationName;
        } catch {
          // multipart bodies are not JSON
        }
      }
      hits.push({ method: req.method || 'GET', op });

      state.inFlight += 1;
      state.maxConcurrency = Math.max(state.maxConcurrency, state.inFlight);

      const respond = (): void => {
        state.inFlight -= 1;
        if (state.mode === 'cf') {
          res.writeHead(403, { 'content-type': 'text/html' });
          res.end('<html><title>Just a moment...</title>Cloudflare Ray ID: test</html>');
          return;
        }
        if (state.mode === 'unauth') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }] }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (state.mode === 'graphql-error') {
          res.end(JSON.stringify({ errors: [{ message: 'boom' }] }));
          return;
        }
        if (op === 'markChatAsRead') {
          res.end(JSON.stringify({ data: { markChatAsRead: { id: 'chat-1' } } }));
          return;
        }
        if (op === 'userChats') {
          res.end(
            JSON.stringify({
              data: {
                chats: {
                  edges: [{ node: { id: 'chat-1', type: 'PM', participants: [] } }],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            }),
          );
          return;
        }
        if (op === 'SbpBankMembers') {
          res.end(JSON.stringify({ data: { sbpBankMembers: [{ id: 'bank-1', name: 'Т-Банк' }] } }));
          return;
        }
        res.end(JSON.stringify({ data: {} }));
      };

      if (state.delayMs > 0) setTimeout(respond, state.delayMs);
      else respond();
    });
  });

  const wss = new WebSocketServer({ server, path: '/graphql' });
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as { type?: string };
      if (frame.type === 'connection_init') socket.send(JSON.stringify({ type: 'connection_ack' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind port');

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    wsUrl: `ws://127.0.0.1:${addr.port}/graphql`,
    hits,
    get maxConcurrency() {
      return state.maxConcurrency;
    },
    setMode: (mode) => {
      state.mode = mode;
    },
    setDelayMs: (ms) => {
      state.delayMs = ms;
    },
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Binds, records the port and releases it: a guaranteed-closed TCP port. */
async function reserveClosedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind port');
  const port = addr.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000, label = 'условие'): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${label} не выполнилось за ${timeoutMs} мс`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const servers: TestServer[] = [];
const transports: GraphQLPlayerokTransport[] = [];

function makeTransport(options: GraphQLTransportOptions): GraphQLPlayerokTransport {
  const transport = new GraphQLPlayerokTransport(options);
  transports.push(transport);
  return transport;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const transport of transports.splice(0)) {
    await transport.close().catch(() => {});
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe('TokenBucket (dependency-free token bucket)', () => {
  it('accumulates fractional tokens and clamps the bucket at capacity', async () => {
    let nowMs = 1_000;
    const bucket = new TokenBucket({
      capacity: 2,
      refillPerSecond: 2,
      name: 'math',
      now: () => nowMs,
    });
    expect(bucket.stats()).toMatchObject({ available: 2, queued: 0, acquired: 0, rejected: 0 });

    await bucket.acquire();
    await bucket.acquire();
    expect(bucket.stats().available).toBe(0);

    nowMs += 250; // 2 tokens/s * 0.25 s = 0.5 token
    expect(bucket.stats().available).toBe(0.5);

    nowMs += 250; // exactly one token again
    expect(bucket.stats().available).toBe(1);
    await bucket.acquire();
    expect(bucket.stats().available).toBe(0);

    nowMs += 60_000; // far beyond capacity: clamped, not unbounded
    expect(bucket.stats().available).toBe(2);
    expect(bucket.stats().acquired).toBe(3);
  });

  it('serves waiters strictly FIFO', async () => {
    // 100 tokens/s = one token every 10 ms; the queue, not the clock, decides the order.
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 100, maxWaitMs: 2_000, name: 'fifo' });
    await bucket.acquire();

    const resolved: number[] = [];
    const waiters = [1, 2, 3, 4].map((n) =>
      bucket.acquire().then(() => {
        resolved.push(n);
      }),
    );
    await Promise.all(waiters);

    expect(resolved).toEqual([1, 2, 3, 4]);
    expect(bucket.stats()).toMatchObject({ queued: 0, acquired: 5, rejected: 0 });
  });

  it('rejects with a clear RateLimitTimeoutError after the configured max wait', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0.0001, maxWaitMs: 30, name: 'slow-bucket' });
    await bucket.acquire();

    const error = await bucket.acquire().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RateLimitTimeoutError);
    expect((error as RateLimitTimeoutError).waitedMs).toBe(30);
    expect((error as RateLimitTimeoutError).bucket).toBe('slow-bucket');
    expect((error as Error).message).toContain('slow-bucket');
    expect(bucket.stats()).toMatchObject({ queued: 0, rejected: 1 });

    // Per-call override wins over the constructor default.
    const quick = await bucket.acquire(5).catch((reason: unknown) => reason);
    expect(quick).toBeInstanceOf(RateLimitTimeoutError);
    expect((quick as RateLimitTimeoutError).waitedMs).toBe(5);
    expect(bucket.stats().rejected).toBe(2);
  });

  it('capacity 0 disables throttling entirely', async () => {
    const bucket = new TokenBucket({ capacity: 0, refillPerSecond: 0, name: 'off' });
    await Promise.all(Array.from({ length: 50 }, () => bucket.acquire()));

    const stats = bucket.stats();
    expect(stats).toMatchObject({ queued: 0, acquired: 50, rejected: 0 });
    expect(stats.available).toBe(Number.POSITIVE_INFINITY);
    expect(bucket.unlimited).toBe(true);
  });

  it('close() rejects every waiter with a transport-closed error and stays idempotent', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0.0001, maxWaitMs: 60_000, name: 'closing' });
    await bucket.acquire();

    const waiters = [
      bucket.acquire().catch((reason: unknown) => reason),
      bucket.acquire().catch((reason: unknown) => reason),
    ];
    expect(bucket.stats().queued).toBe(2);

    bucket.close();
    const results = await Promise.all(waiters);
    expect(results.every((result) => result instanceof RateLimitClosedError)).toBe(true);
    expect(bucket.stats()).toMatchObject({ queued: 0, rejected: 2, acquired: 1 });
    expect(bucket.closed).toBe(true);

    const afterClose = await bucket.acquire().catch((reason: unknown) => reason);
    expect(afterClose).toBeInstanceOf(RateLimitClosedError);

    bucket.close(); // idempotent: no throw, no extra counters
    expect(bucket.stats().rejected).toBe(2);
  });

  it('keeps at most one pump timer while waiting and clears it when the queue drains or the bucket closes', async () => {
    vi.useFakeTimers();
    try {
      const baseline = vi.getTimerCount();
      let clockMs = 0;
      const bucket = new TokenBucket({
        capacity: 1,
        refillPerSecond: 10,
        name: 'timers',
        now: () => clockMs,
      });

      await bucket.acquire(); // immediate: no waiting, no timer
      expect(vi.getTimerCount()).toBe(baseline);

      const first = bucket.acquire();
      const second = bucket.acquire();
      expect(bucket.stats().queued).toBe(2);
      expect(vi.getTimerCount()).toBe(baseline + 1); // exactly one pump timer

      clockMs = 1_000; // plenty of tokens available now
      await vi.advanceTimersByTimeAsync(120);
      await first;
      expect(bucket.stats().queued).toBe(1);

      clockMs = 2_000;
      await vi.advanceTimersByTimeAsync(120);
      await second;
      expect(bucket.stats().queued).toBe(0);
      expect(vi.getTimerCount()).toBe(baseline); // nothing left behind

      const third = bucket.acquire();
      expect(vi.getTimerCount()).toBe(baseline + 1);
      bucket.close();
      await expect(third).rejects.toBeInstanceOf(RateLimitClosedError);
      expect(vi.getTimerCount()).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GraphQLPlayerokTransport throttling + outbound stats', () => {
  it('throttles a burst of N > capacity HTTP calls: all complete, concurrency never exceeds capacity', async () => {
    const srv = await createTestServer();
    servers.push(srv);
    srv.setDelayMs(5);

    const transport = makeTransport({
      baseUrl: srv.baseUrl,
      wsUrl: srv.wsUrl,
      cookies: 'token=secret',
      httpRateLimit: { capacity: 3, refillPerSecond: 20 },
      wsRateLimit: { capacity: 0 },
    });

    const burstSize = 12;
    await Promise.all(
      Array.from({ length: burstSize }, (_, i) => transport.markChatAsRead(`chat-${i}`)),
    );

    expect(srv.hits).toHaveLength(burstSize);
    expect(srv.maxConcurrency).toBeLessThanOrEqual(3);
    expect(srv.maxConcurrency).toBeGreaterThan(1); // the burst really was parallel

    const stats = transport.getRequestStats();
    expect(stats.requests.markChatAsRead).toBe(burstSize);
    expect(stats.totalRequests).toBe(burstSize);
    expect(stats.latency.count).toBe(burstSize);
    expect(stats.latency.totalMs).toBeGreaterThan(0);
    expect(stats.latency.averageMs).toBeGreaterThan(0);
    expect(stats.failures).toEqual({ unauthorized: 0, 'bot-check': 0, network: 0, graphql: 0 });
    expect(stats.limiters.http.acquired).toBe(burstSize);
    expect(stats.limiters.http.queued).toBe(0);
    expect(stats.limiters.http.rejected).toBe(0);
  });

  it('counts successes and each failure class (unauthorized / bot-check / graphql)', async () => {
    const srv = await createTestServer();
    servers.push(srv);

    const transport = makeTransport({
      baseUrl: srv.baseUrl,
      cookies: 'token=secret',
      httpRateLimit: { capacity: 0 },
      wsRateLimit: { capacity: 0 },
    });

    await expect(transport.getSbpBankMembers()).resolves.toHaveLength(1);

    srv.setMode('graphql-error');
    await expect(transport.getSbpBankMembers()).rejects.toBeTruthy();

    srv.setMode('unauth');
    await expect(transport.getSbpBankMembers()).rejects.toBeInstanceOf(UnauthorizedError);

    srv.setMode('cf');
    await expect(transport.getSbpBankMembers()).rejects.toBeInstanceOf(BotCheckDetectedError);

    const stats = transport.getRequestStats();
    expect(stats.requests.SbpBankMembers).toBe(4);
    expect(stats.totalRequests).toBe(4);
    expect(stats.failures).toEqual({ unauthorized: 1, 'bot-check': 1, network: 0, graphql: 1 });
    expect(stats.latency.count).toBe(4);
  });

  it('classifies a dead endpoint as a network failure', async () => {
    const closedPort = await reserveClosedPort();
    const transport = makeTransport({
      baseUrl: `http://127.0.0.1:${closedPort}`,
      cookies: 'token=secret',
      httpRateLimit: { capacity: 0 },
      wsRateLimit: { capacity: 0 },
    });

    await expect(transport.getSbpBankMembers()).rejects.toBeTruthy();

    const stats = transport.getRequestStats();
    expect(stats.failures).toEqual({ unauthorized: 0, 'bot-check': 0, network: 1, graphql: 0 });
    expect(stats.requests.SbpBankMembers).toBe(1);
  });

  it('routes every WS send through the separate WS bucket and reports ws:* operations', async () => {
    const srv = await createTestServer();
    servers.push(srv);

    const transport = makeTransport({
      baseUrl: srv.baseUrl,
      wsUrl: srv.wsUrl,
      cookies: 'token=secret',
      httpRateLimit: { capacity: 0 },
      wsRateLimit: { capacity: 2, refillPerSecond: 20 },
    });

    const unsubscribe = await transport.subscribe(() => {});
    await waitFor(
      () => (transport.getRequestStats().requests['ws:subscribe'] ?? 0) >= 2,
      3_000,
      'WS subscribe frames',
    );

    const stats = transport.getRequestStats();
    expect(stats.requests['ws:connection_init']).toBe(1);
    expect(stats.requests['ws:subscribe']).toBeGreaterThanOrEqual(2);
    expect(stats.limiters.ws.acquired).toBeGreaterThanOrEqual(3);
    expect(stats.limiters.ws.queued).toBe(0);

    unsubscribe();
  });

  it('close() drains pending HTTP acquires instead of leaving them hanging', async () => {
    const srv = await createTestServer();
    servers.push(srv);
    srv.setDelayMs(30);

    const transport = makeTransport({
      baseUrl: srv.baseUrl,
      cookies: 'token=secret',
      httpRateLimit: { capacity: 1, refillPerSecond: 0.001, maxWaitMs: 60_000 },
      wsRateLimit: { capacity: 0 },
    });

    const pending = Array.from({ length: 4 }, (_, i) =>
      transport.markChatAsRead(`chat-${i}`).then(
        () => 'ok' as const,
        (error: unknown) => error,
      ),
    );
    await waitFor(() => srv.hits.length >= 1, 3_000, 'первый HTTP-запрос');

    await transport.close();
    const results = await Promise.all(pending);

    expect(results).toHaveLength(4);
    expect(results.filter((result) => result instanceof RateLimitClosedError)).toHaveLength(3);
    // A closed transport rejects immediately instead of queueing forever.
    await expect(transport.getSbpBankMembers()).rejects.toBeInstanceOf(RateLimitClosedError);
  });

  it('exposes transport stats through PlayerokService, zeroed when the transport is not instrumented', async () => {
    const srv = await createTestServer();
    servers.push(srv);
    const transport = makeTransport({
      baseUrl: srv.baseUrl,
      cookies: 'token=secret',
      httpRateLimit: { capacity: 0 },
      wsRateLimit: { capacity: 0 },
    });
    await transport.getSbpBankMembers();

    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-rl-')) });
    await ctx.use(PlayerokService, { transport, enableMaintenanceLoops: false });
    expect(ctx.playerok.getRequestStats()).toEqual(transport.getRequestStats());
    expect(ctx.playerok.getRequestStats().requests.SbpBankMembers).toBe(1);
    await ctx.fiber.dispose();

    // The mock never touches the network: every counter is zero.
    const mockCtx = new Context();
    await mockCtx.use(StorageService, { baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-rl-')) });
    await mockCtx.use(PlayerokService, {
      dryRun: true,
      transport: new MockPlayerokTransport(),
      enableMaintenanceLoops: false,
    });
    const empty = mockCtx.playerok.getRequestStats();
    expect(empty.requests).toEqual({});
    expect(empty.failures).toEqual({ unauthorized: 0, 'bot-check': 0, network: 0, graphql: 0 });
    expect(empty.totalRequests).toBe(0);
    expect(empty.latency).toEqual({ totalMs: 0, count: 0, averageMs: 0 });
    expect(empty.limiters.http).toEqual({ available: 0, queued: 0, acquired: 0, rejected: 0 });
    expect(empty.limiters.ws).toEqual({ available: 0, queued: 0, acquired: 0, rejected: 0 });
    await mockCtx.fiber.dispose();

    // A third-party transport without the optional method still yields zeroed stats.
    const bare = new MockPlayerokTransport();
    Object.defineProperty(bare, 'getRequestStats', { value: undefined, configurable: true });
    const bareCtx = new Context();
    await bareCtx.use(StorageService, { baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-rl-')) });
    await bareCtx.use(PlayerokService, { transport: bare, enableMaintenanceLoops: false });
    expect(bareCtx.playerok.getRequestStats().totalRequests).toBe(0);
    await bareCtx.fiber.dispose();
  });
});
