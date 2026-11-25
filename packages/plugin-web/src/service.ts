import crypto from 'node:crypto';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Logger } from 'cordis';
import {
  type AccountInfo,
  type CachedOrder,
  type Context,
  Service,
  VERSION,
} from '@pkh/core';
import type { PlayerokService } from '@pkh/adapter';
import { type AnalyticsView, computeAnalytics } from './analytics.js';
import {
  type AccountView,
  type BootErrorView,
  type DealView,
  type OverviewView,
  type QueueStatsView,
  type QueueTaskView,
  renderAnalytics,
  renderDeals,
  renderLogs,
  renderNotFound,
  renderOverview,
  renderQueue,
  renderUnauthorized,
} from './render.js';

export interface WebDashboardConfig {
  /** When false the service stays mounted (and injectable) but never opens a socket. */
  enabled?: boolean;
  /** Listen address. A non-loopback address is only allowed together with a token. */
  host?: string;
  /** TCP port; 0 asks the OS for a free port (used by tests). */
  port?: number;
  /** Shared access token; defaults to the PKH_WEB_TOKEN environment variable. */
  token?: string;
  /**
   * SSE keep-alive interval in milliseconds; defaults to {@link SSE_HEARTBEAT_MS}.
   * Exists so tests can observe a ping without waiting fifteen seconds.
   */
  heartbeatMs?: number;
}

/** One frame kept in the SSE replay ring buffer. */
export interface BufferedEventFrame {
  /** Monotonically increasing sequence number, also written as the SSE `id:` field. */
  id: number;
  /** Event name, mirroring the bus event that produced the frame. */
  event: string;
  /** Serialized JSON envelope (`data:` payload), stored so a replay is byte-identical. */
  data: string;
}

export const DEFAULT_WEB_HOST = '127.0.0.1';
export const DEFAULT_WEB_PORT = 8787;
export const TOKEN_COOKIE_NAME = 'pkh_web_token';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_DEAL_ROWS = 100;
const MAX_QUEUE_ROWS = 100;
const MAX_LOG_LINES = 200;
const ACCOUNT_CACHE_MS = 5_000;
/** Lifetime of a token minted by {@link WebDashboardService.mintAccessToken}: one click, ten minutes. */
export const ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000;
/** Hard cap on minted-but-unused tokens, so a chatty button cannot grow the map without limit. */
export const MAX_ACCESS_TOKENS = 50;
/** Frames kept for Last-Event-ID replay; older ones are dropped, memory stays bounded. */
export const MAX_EVENT_BUFFER = 200;
/** SSE comment written every fifteen seconds so proxies keep the stream open. */
export const SSE_HEARTBEAT_MS = 15_000;

/**
 * Thrown when the dashboard would be reachable from outside the machine without
 * authentication. Refusing to boot is safer than silently exposing seller data.
 */
export class WebDashboardSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebDashboardSecurityError';
  }
}

/** Structural view of @pkh/plugin-retry-queue, which stays an optional dependency. */
interface QueueTaskLike {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  nextRunAt: string;
}

interface RetryQueueLike {
  getStats(): QueueStatsView;
  list(status?: 'pending' | 'dead'): QueueTaskLike[];
}

function resolveToken(configToken?: string): string {
  if (configToken !== undefined) return configToken.trim();
  return (process.env.PKH_WEB_TOKEN ?? '').trim();
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Constant-time comparison so a wrong token cannot be guessed byte by byte. */
function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) {
    crypto.timingSafeEqual(leftBytes, leftBytes);
    return false;
  }
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (name.length === 0) continue;
    cookies[name] = decodeCookieValue(part.slice(separator + 1).trim());
  }
  return cookies;
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseRequestUrl(req: IncomingMessage, host: string, port: number): URL {
  const hostHeader = req.headers.host;
  const base =
    hostHeader && hostHeader.length > 0 ? `http://${hostHeader}` : `http://${host}:${port}`;
  try {
    return new URL(req.url ?? '/', base);
  } catch {
    return new URL('/', `http://${host}:${port}`);
  }
}

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; connect-src 'self'",
  );
}

function serializeEvent(event: string, payload: unknown): string {
  try {
    return JSON.stringify({ event, at: new Date().toISOString(), data: payload });
  } catch {
    // Circular or BigInt payloads must not break the live stream.
    return JSON.stringify({ event, at: new Date().toISOString(), data: null });
  }
}

/**
 * One SSE frame. The `id:` field is what a reconnecting client echoes back in
 * Last-Event-ID, so every frame must carry it.
 */
function formatEventFrame(frame: BufferedEventFrame): string {
  return `id: ${frame.id}\ndata: ${frame.data}\n\n`;
}

function toAccountView(account: AccountInfo): AccountView {
  return {
    id: account.id,
    username: account.username,
    email: account.email ?? null,
    role: account.role ?? null,
    isBlocked: Boolean(account.isBlocked),
  };
}

function toDealView(order: CachedOrder): DealView {
  return {
    id: order.id,
    itemId: order.item_id,
    itemName: order.item_name,
    price: order.price,
    status: order.status,
    date: order.date,
  };
}

function toQueueTaskView(task: QueueTaskLike): QueueTaskView {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    lastError: task.lastError ?? null,
    nextRunAt: task.nextRunAt,
  };
}

function compareDealsNewestFirst(left: DealView, right: DealView): number {
  if (left.date === right.date) return right.id.localeCompare(left.id);
  return right.date.localeCompare(left.date);
}

function compareQueueTasks(left: QueueTaskView, right: QueueTaskView): number {
  if (left.status !== right.status) return left.status === 'pending' ? -1 : 1;
  return left.nextRunAt.localeCompare(right.nextRunAt);
}

/**
 * Read-only observability dashboard: a dependency-free node:http server that
 * renders cached deals, the retry queue, logs and live events as HTML/JSON.
 */
export class WebDashboardService extends Service {
  static provide = 'webDashboard';
  static inject = ['storage', 'playerok', 'plugins'];

  public readonly enabled: boolean;
  public readonly host: string;
  public readonly configuredPort: number;
  public readonly startedAt: number = Date.now();

  private readonly token: string;
  private readonly log: Logger;
  private boundPort: number | null = null;
  /** Settles once the HTTP server bound, was disabled, or failed to bind. */
  public readonly ready: Promise<void>;
  /** Set when the server could not bind; `ready` still settles so callers never hang. */
  public startupError: Error | null = null;
  private resolveReady!: () => void;
  private readonly sockets = new Set<Socket>();
  private readonly streams = new Set<ServerResponse>();
  /** Newest SSE frames, capped at MAX_EVENT_BUFFER, used for Last-Event-ID replay. */
  private readonly eventBuffer: BufferedEventFrame[] = [];
  /** Id source for SSE frames; monotonic for the lifetime of the service. */
  private nextEventId = 0;
  /** One keep-alive timer per attached SSE stream. */
  private readonly streamTimers = new Map<ServerResponse, NodeJS.Timeout>();
  /** SSE keep-alive interval, overridable in the config for tests. */
  public readonly heartbeatMs: number;
  private accountCache: { at: number; account: AccountInfo | null; error: string | null } | null =
    null;
  /**
   * Minted one-time dashboard tokens -> expiry timestamp (epoch ms). Memory only: a
   * restart invalidates every outstanding link, which is what "short-lived" must mean.
   */
  private readonly accessTokens = new Map<string, number>();

  constructor(ctx: Context, config: WebDashboardConfig = {}) {
    super(ctx, 'webDashboard');
    this.log = ctx.logger('webDashboard');
    this.ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    this.enabled = config.enabled !== false;
    this.host = config.host ?? DEFAULT_WEB_HOST;
    this.configuredPort = config.port ?? DEFAULT_WEB_PORT;
    this.token = resolveToken(config.token);
    const configuredHeartbeat = config.heartbeatMs;
    this.heartbeatMs =
      typeof configuredHeartbeat === 'number' &&
      Number.isFinite(configuredHeartbeat) &&
      configuredHeartbeat > 0
        ? Math.floor(configuredHeartbeat)
        : SSE_HEARTBEAT_MS;

    if (
      !Number.isInteger(this.configuredPort) ||
      this.configuredPort < 0 ||
      this.configuredPort > 65535
    ) {
      throw new RangeError(`Некорректный порт веб-панели: ${String(config.port)}`);
    }

    // A reachable-from-outside dashboard exposes the seller account, so it must
    // have a token. Loopback-only deployments may run without one.
    if (!isLoopbackHost(this.host) && this.token.length === 0) {
      throw new WebDashboardSecurityError(
        `Веб-панель не может слушать ${this.host} без токена: укажите token в конфиге или задайте PKH_WEB_TOKEN`,
      );
    }

    ctx.effect(() => this.startHttpServer(), 'webDashboard:http');
    ctx.effect(() => this.subscribeEvents(), 'webDashboard:events');
  }

  /** Actual bound address (port is resolved even when the config asked for port 0). */
  public get address(): { host: string; port: number } | null {
    return this.boundPort === null ? null : { host: this.host, port: this.boundPort };
  }

  public get url(): string | null {
    return this.boundPort === null ? null : `http://${this.host}:${this.boundPort}`;
  }

  /** Number of currently attached SSE clients. */
  public get openStreams(): number {
    return this.streams.size;
  }

  /** Number of running SSE keep-alive timers; must be 0 after dispose. */
  public get heartbeatTimers(): number {
    return this.streamTimers.size;
  }

  /** Id of the newest buffered frame, 0 before the first broadcast. */
  public get lastEventId(): number {
    return this.nextEventId;
  }

  /** Snapshot of the replay ring buffer, oldest first. */
  public get bufferedEvents(): readonly BufferedEventFrame[] {
    return [...this.eventBuffer];
  }

  /** Number of minted links that were not used yet (never above {@link MAX_ACCESS_TOKENS}). */
  public get accessTokenCount(): number {
    return this.accessTokens.size;
  }

  /**
   * Mints a single-use dashboard token, e.g. for a chat button that must not carry the
   * shared long-lived token in message history. The token authenticates exactly one
   * request, then it is gone; expiry and the {@link MAX_ACCESS_TOKENS} cap keep the
   * in-memory map pruned and bounded. Returns null when the dashboard is disabled.
   */
  public mintAccessToken(ttlMs: number = ACCESS_TOKEN_TTL_MS): string | null {
    if (!this.enabled) return null;
    const now = Date.now();
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : ACCESS_TOKEN_TTL_MS;
    this.pruneAccessTokens(now);
    // Oldest entry first: insertion order is mint order, and tokens are never refreshed.
    while (this.accessTokens.size >= MAX_ACCESS_TOKENS) {
      const oldest = this.accessTokens.keys().next();
      if (oldest.done) break;
      this.accessTokens.delete(oldest.value);
    }
    const token = crypto.randomBytes(24).toString('base64url');
    this.accessTokens.set(token, now + ttl);
    return token;
  }

  /** Drops expired minted tokens; called on mint and on every consumption. */
  private pruneAccessTokens(now: number): void {
    for (const [token, expiresAt] of this.accessTokens) {
      if (expiresAt <= now) this.accessTokens.delete(token);
    }
  }

  /**
   * Validates and consumes a minted token: a second request with the same value finds
   * nothing and is rejected. Returns false for unknown, already used or expired tokens.
   */
  private consumeAccessToken(candidate: string | null): boolean {
    if (candidate === null || candidate.length === 0) return false;
    const now = Date.now();
    this.pruneAccessTokens(now);
    const expiresAt = this.accessTokens.get(candidate);
    if (expiresAt === undefined) return false;
    // Single use: delete before returning, whatever the expiry outcome.
    this.accessTokens.delete(candidate);
    return expiresAt > now;
  }

  private async startHttpServer(): Promise<() => Promise<void>> {
    if (!this.enabled) {
      this.log.info('Веб-панель отключена в конфиге');
      this.resolveReady();
      return async () => {};
    }

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => {
        this.sockets.delete(socket);
      });
    });

    server.on('clientError', (error, socket) => {
      this.log.debug(`Ошибка HTTP-клиента: ${describeError(error)}`);
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.configuredPort, this.host);
      });
    } catch (error) {
      const message = describeError(error);
      this.log.error(
        `Не удалось запустить веб-панель на ${this.host}:${this.configuredPort}: ${message}`,
      );
      this.startupError = new Error(
        `Веб-панель не смогла занять ${this.host}:${this.configuredPort}: ${message}`,
        { cause: error },
      );
      this.resolveReady();
      throw this.startupError;
    }

    const address = server.address();
    if (address !== null && typeof address === 'object') {
      this.boundPort = (address as AddressInfo).port;
    }
    this.log.info(
      `Веб-панель слушает ${this.url} ${this.token.length > 0 ? '(доступ по токену)' : '(без токена, только loopback)'}`,
    );
    this.resolveReady();

    return async () => this.stopHttpServer(server);
  }

  private async stopHttpServer(server: Server): Promise<void> {
    this.boundPort = null;
    // Links minted for the old socket are useless once the port is gone.
    this.accessTokens.clear();
    this.closeAllStreams();
    // Let the SSE shutdown frames reach the sockets before tearing them down.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    if (!server.listening) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private subscribeEvents(): () => void {
    const disposers: Array<() => boolean> = [
      this.ctx.on('playerok/new-deal', (event) => {
        this.broadcast('playerok/new-deal', event);
      }),
      this.ctx.on('notify/log', (payload) => {
        this.broadcast('notify/log', payload);
      }),
      this.onBus('retry/enqueued', (payload) => {
        this.broadcast('retry/enqueued', payload);
      }),
      this.onBus('retry/dead-letter', (payload) => {
        this.broadcast('retry/dead-letter', payload);
      }),
    ];

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // the shared bus may already be gone during shutdown
        }
      }
      this.closeAllStreams();
    };
  }

  /**
   * `retry/*` events are declared by the optional @pkh/plugin-retry-queue package,
   * which this dashboard must not depend on. Subscribe by name on the shared bus.
   */
  private onBus(event: string, listener: (payload: unknown) => void): () => boolean {
    const register = this.ctx.on.bind(this.ctx) as unknown as (
      name: string,
      handler: (payload: unknown) => void,
    ) => () => boolean;
    return register(event, listener);
  }

  private broadcast(event: string, payload: unknown): void {
    this.nextEventId += 1;
    const frame: BufferedEventFrame = {
      id: this.nextEventId,
      event,
      data: serializeEvent(event, payload),
    };
    // Buffer even with no client attached: a reconnecting client can still catch up.
    this.pushBufferedFrame(frame);

    if (this.streams.size === 0) return;
    const wire = formatEventFrame(frame);
    for (const stream of this.streams) {
      this.writeFrame(stream, wire);
    }
  }

  /** Ring-buffer append; the oldest frames fall off once the cap is reached. */
  private pushBufferedFrame(frame: BufferedEventFrame): void {
    this.eventBuffer.push(frame);
    const overflow = this.eventBuffer.length - MAX_EVENT_BUFFER;
    if (overflow > 0) this.eventBuffer.splice(0, overflow);
  }

  private writeFrame(stream: ServerResponse, frame: string): void {
    if (stream.writableEnded || stream.destroyed) {
      this.dropStream(stream);
      return;
    }
    try {
      stream.write(frame);
    } catch {
      this.dropStream(stream);
    }
  }

  /** Remove a client and stop its keep-alive timer; safe to call twice. */
  private dropStream(stream: ServerResponse): void {
    this.streams.delete(stream);
    const timer = this.streamTimers.get(stream);
    if (timer !== undefined) {
      clearInterval(timer);
      this.streamTimers.delete(stream);
    }
  }

  private startHeartbeat(stream: ServerResponse): void {
    const timer = setInterval(() => {
      this.writeFrame(stream, ': ping\n\n');
    }, this.heartbeatMs);
    // A keep-alive must never be the reason the process stays alive.
    timer.unref();
    this.streamTimers.set(stream, timer);
  }

  private closeAllStreams(): void {
    for (const timer of this.streamTimers.values()) {
      clearInterval(timer);
    }
    this.streamTimers.clear();

    for (const stream of this.streams) {
      try {
        stream.end('event: shutdown\ndata: {}\n\n');
      } catch {
        // client is already gone
      }
    }
    this.streams.clear();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      applySecurityHeaders(res);
      const url = parseRequestUrl(req, this.host, this.boundPort ?? this.configuredPort);

      if (req.method !== 'GET') {
        this.sendText(res, 405, 'Метод не поддерживается: панель только для чтения');
        return;
      }

      if (url.pathname === '/healthz') {
        this.sendJson(res, 200, {
          ok: true,
          uptime: Math.round((Date.now() - this.startedAt) / 1000),
          version: VERSION,
        });
        return;
      }

      const queryToken = url.searchParams.get('token');
      const authorizedByQuery =
        this.token.length > 0 && queryToken !== null && safeEqual(queryToken, this.token);
      // A minted token is accepted exactly like the shared one, but only once: the link
      // usually comes from a chat where it would otherwise stay valid forever.
      const authorizedByMinted = !authorizedByQuery && this.consumeAccessToken(queryToken);

      if (!authorizedByQuery && !authorizedByMinted && !this.isAuthorized(req)) {
        this.sendHtml(res, 401, renderUnauthorized());
        return;
      }
      if (authorizedByQuery) {
        res.setHeader('Set-Cookie', this.buildTokenCookie());
      } else if (authorizedByMinted && this.token.length > 0) {
        // Session cookie: the browser keeps the session for navigation but forgets the
        // credential on close, unlike the seven-day cookie of the shared token. Without a
        // shared token (loopback-only mode) there is nothing to remember.
        res.setHeader('Set-Cookie', this.buildSessionTokenCookie());
      }

      await this.route(req, res, url);
    } catch (error) {
      this.log.error(
        `Ошибка обработки запроса ${req.method ?? 'GET'} ${req.url ?? '/'}: ${describeError(error)}`,
      );
      if (!res.headersSent) {
        this.sendText(res, 500, 'Внутренняя ошибка веб-панели');
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (this.token.length === 0) return true; // loopback-only mode, enforced in the constructor
    const cookieToken = parseCookies(req.headers.cookie)[TOKEN_COOKIE_NAME];
    return cookieToken !== undefined && safeEqual(cookieToken, this.token);
  }

  private buildTokenCookie(): string {
    return `${TOKEN_COOKIE_NAME}=${encodeURIComponent(this.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`;
  }

  /** Same credential, no Max-Age: it must die with the browser session. */
  private buildSessionTokenCookie(): string {
    return `${TOKEN_COOKIE_NAME}=${encodeURIComponent(this.token)}; HttpOnly; SameSite=Lax; Path=/`;
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    switch (url.pathname) {
      case '/': {
        this.sendHtml(res, 200, renderOverview(await this.buildOverview()));
        return;
      }
      case '/analytics': {
        this.sendHtml(res, 200, renderAnalytics(this.collectAnalytics()));
        return;
      }
      case '/deals': {
        this.sendHtml(res, 200, renderDeals(this.collectDeals()));
        return;
      }
      case '/queue': {
        this.sendHtml(res, 200, renderQueue(this.collectQueue()));
        return;
      }
      case '/logs': {
        this.sendHtml(res, 200, renderLogs(this.readLogLines()));
        return;
      }
      case '/api/status': {
        this.sendJson(res, 200, { ok: true, ...(await this.buildOverview()) });
        return;
      }
      case '/api/analytics': {
        this.sendJson(res, 200, this.collectAnalytics());
        return;
      }
      case '/api/deals': {
        this.sendJson(res, 200, this.collectDeals());
        return;
      }
      case '/api/queue': {
        this.sendJson(res, 200, this.collectQueue());
        return;
      }
      case '/events': {
        this.handleEvents(req, res, url);
        return;
      }
      default: {
        this.sendHtml(res, 404, renderNotFound());
      }
    }
  }

  /**
   * Attach an SSE client: greeting, optional replay of buffered frames newer than
   * the client's Last-Event-ID, then live frames plus a 15 s keep-alive ping.
   *
   * Registration happens before the replay and the replay is synchronous, so no
   * live frame can slip between the two and no frame is delivered twice.
   */
  private handleEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    this.streams.add(res);

    const cleanup = () => {
      this.dropStream(res);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);

    this.startHeartbeat(res);

    const lastEventId = this.readLastEventId(req, url);
    if (lastEventId !== null) this.replayAfter(res, lastEventId);
  }

  /** Last-Event-ID header or ?lastEventId=; null when the client did not resume. */
  private readLastEventId(req: IncomingMessage, url: URL): number | null {
    const header = req.headers['last-event-id'];
    const raw =
      typeof header === 'string' && header.trim().length > 0
        ? header
        : url.searchParams.get('lastEventId');
    if (raw === null) return null;
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  private replayAfter(res: ServerResponse, lastEventId: number): void {
    let replayed = 0;
    for (const frame of this.eventBuffer) {
      if (frame.id <= lastEventId) continue;
      this.writeFrame(res, formatEventFrame(frame));
      replayed += 1;
    }
    this.log.debug(
      `Поток SSE продолжен с id ${lastEventId}: повторов ${replayed}, в буфере ${this.eventBuffer.length}`,
    );
  }

  private async buildOverview(): Promise<OverviewView> {
    const account = await this.readAccount();
    return {
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      host: this.host,
      port: this.boundPort ?? this.configuredPort,
      account: account.account ? toAccountView(account.account) : null,
      accountError: account.error,
      cachedOrders: this.countCachedOrders(),
      queue: this.readQueueStats(),
      plugins: this.readPluginSummary(),
      bootErrors: this.readBootErrors(),
    };
  }

  private async readAccount(): Promise<{ account: AccountInfo | null; error: string | null }> {
    const playerok: PlayerokService = this.ctx.playerok;
    const current: AccountInfo | null = playerok.account;
    if (current) return { account: current, error: null };

    const now = Date.now();
    if (this.accountCache && now - this.accountCache.at < ACCOUNT_CACHE_MS) {
      return { account: this.accountCache.account, error: this.accountCache.error };
    }

    let account: AccountInfo | null = null;
    let error: string | null = null;
    try {
      account = await playerok.refreshAccount();
      if (!account) error = 'PlayerOK не вернул данные аккаунта';
    } catch (cause) {
      error = describeError(cause);
    }
    this.accountCache = { at: now, account, error };
    if (error) {
      this.log.warn(`Не удалось обновить аккаунт для веб-панели: ${error}`);
    }
    return { account, error };
  }

  /**
   * Revenue snapshot computed from the existing `cached_orders` store; the
   * dashboard deliberately owns no analytics store of its own.
   */
  private collectAnalytics(): AnalyticsView {
    let cached: Record<string, CachedOrder> = {};
    try {
      cached = this.ctx.storage.getCachedOrders();
    } catch (error) {
      this.log.warn(`Не удалось прочитать кэш сделок для аналитики: ${describeError(error)}`);
    }
    return computeAnalytics(Object.values(cached), Date.now());
  }

  private countCachedOrders(): number {
    try {
      return Object.keys(this.ctx.storage.getCachedOrders()).length;
    } catch (error) {
      this.log.warn(`Не удалось прочитать кэш сделок: ${describeError(error)}`);
      return 0;
    }
  }

  private collectDeals(): { total: number; deals: DealView[] } {
    let cached: Record<string, CachedOrder>;
    try {
      cached = this.ctx.storage.getCachedOrders();
    } catch (error) {
      this.log.warn(`Не удалось прочитать кэш сделок: ${describeError(error)}`);
      return { total: 0, deals: [] };
    }

    const deals = Object.values(cached).map(toDealView).sort(compareDealsNewestFirst);
    return { total: deals.length, deals: deals.slice(0, MAX_DEAL_ROWS) };
  }

  private retryQueue(): RetryQueueLike | null {
    return (this.ctx.get('retryQueue', false) as RetryQueueLike | undefined) ?? null;
  }

  private readQueueStats(): QueueStatsView | null {
    const queue = this.retryQueue();
    if (!queue) return null;
    try {
      return queue.getStats();
    } catch (error) {
      this.log.warn(`Не удалось получить статистику очереди: ${describeError(error)}`);
      return null;
    }
  }

  private collectQueue(): { stats: QueueStatsView | null; tasks: QueueTaskView[] } {
    const queue = this.retryQueue();
    if (!queue) return { stats: null, tasks: [] };
    try {
      const stats = queue.getStats();
      // list() without a status filter: a task that is being retried right now is in
      // 'processing' and used to disappear from the dashboard mid-flight.
      const tasks = queue.list()
        .map(toQueueTaskView)
        .sort(compareQueueTasks)
        .slice(0, MAX_QUEUE_ROWS);
      return { stats, tasks };
    } catch (error) {
      this.log.warn(`Не удалось прочитать очередь повторов: ${describeError(error)}`);
      return { stats: null, tasks: [] };
    }
  }

  private readPluginSummary(): { enabled: number; total: number } {
    try {
      const records = this.ctx.plugins.list();
      return { enabled: records.filter((record) => record.enabled).length, total: records.length };
    } catch (error) {
      this.log.warn(`Не удалось получить список плагинов: ${describeError(error)}`);
      return { enabled: 0, total: 0 };
    }
  }

  private readBootErrors(): BootErrorView[] {
    const report = this.ctx.get('bootReport', false);
    if (!report) return [];
    try {
      return report.getErrors().slice(0, 10).map((error) => ({
        module: error.module,
        stage: error.stage,
        text: error.text,
      }));
    } catch (error) {
      this.log.warn(`Не удалось прочитать отчёт о запуске: ${describeError(error)}`);
      return [];
    }
  }

  private readLogLines(): string[] {
    const sink = this.ctx.get('logSink', false);
    if (!sink) return [];
    try {
      return sink.getRecentLines(MAX_LOG_LINES).slice(-MAX_LOG_LINES);
    } catch (error) {
      this.log.warn(`Не удалось прочитать логи: ${describeError(error)}`);
      return [];
    }
  }

  private sendHtml(res: ServerResponse, status: number, body: string): void {
    this.send(res, status, 'text/html; charset=utf-8', body);
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    this.send(res, status, 'application/json; charset=utf-8', `${JSON.stringify(payload)}\n`);
  }

  private sendText(res: ServerResponse, status: number, body: string): void {
    this.send(res, status, 'text/plain; charset=utf-8', `${body}\n`);
  }

  private send(res: ServerResponse, status: number, contentType: string, body: string): void {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }
}

declare module 'cordis' {
  interface Context {
    webDashboard: WebDashboardService;
  }
}
