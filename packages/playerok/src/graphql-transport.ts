import crypto from 'node:crypto';
import WebSocket from 'ws';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  ChatTypes,
  EventTypes,
  ItemDealStatuses,
  ItemStatuses,
  PriorityTypes,
  ReviewStatuses,
  SortDirections,
  TransactionDirections,
  TransactionOperations,
  TransactionProviderIds,
  TransactionStatuses,
  parseCookieString,
  z,
  type AccountInfo,
  type Chat,
  type ChatMessage,
  type ChatStatuses,
  type DataField,
  type ItemDeal,
  type ItemDealDirections,
  type ItemPriorityStatus,
  type MyItem,
  type PaginatedList,
  type PlayerokEvent,
  type Review,
  type SbpBankMember,
  type Transaction,
  type UserProfile,
  type UserTypes,
  type VerifiedCard,
} from '@pkh/core';
import {
  BotCheckDetectedError,
  RequestFailedError,
  UnauthorizedError,
} from './errors.js';
import { GQL_QUERIES, PERSISTED_QUERIES } from './queries.js';
import { TokenBucket, type RateLimitOptions } from './rate-limit.js';
import {
  chatMessagesPayloadSchema,
  chatPayloadSchema,
  chatsPayloadSchema,
  createChatMessagePayloadSchema,
  createItemPayloadSchema,
  dealPayloadSchema,
  dealsPayloadSchema,
  increaseItemPriorityStatusPayloadSchema,
  itemPayloadSchema,
  itemPriorityStatusesPayloadSchema,
  itemsPayloadSchema,
  publishItemPayloadSchema,
  removeTransactionPayloadSchema,
  reportDealProblemPayloadSchema,
  requestWithdrawalPayloadSchema,
  reviewsPayloadSchema,
  sbpBankMembersPayloadSchema,
  transactionsPayloadSchema,
  updateDealPayloadSchema,
  updateItemPayloadSchema,
  uploadChatImagePayloadSchema,
  userPayloadSchema,
  verifiedCardsPayloadSchema,
  viewerPayloadSchema,
  wsNextPayloadSchema,
  type ChatMessageNode,
  type ChatNode,
  type ContractIssue,
  type DealNode,
  type EmbeddedDealNode,
  type ItemNode,
  type ProfileNode,
  type TransactionNode,
  type UserNode,
  type VerifiedCardNode,
} from './schemas.js';
import type {
  BinaryUpload,
  CreateItemParams,
  GetDealsParams,
  GetMyItemsParams,
  GetReviewsParams,
  PlayerokEventHandler,
  PlayerokTransport,
  RequestFailureClass,
  RequestStats,
  RequestWithdrawalParams,
  SendMessageParams,
  UpdateItemParams,
} from './transport.js';

export interface GraphQLTransportOptions {
  baseUrl?: string;
  wsUrl?: string;
  cookies: string;
  userAgent?: string;
  proxy?: string;
  timeoutMs?: number;
  reviewPollIntervalMs?: number;
  newDealsPollIntervalMs?: number;
  wsPingIntervalMs?: number;
  /**
   * Outbound HTTP throttle (persisted GET, POST mutation, multipart upload,
   * file download). `capacity: 0` disables it, e.g. in tests.
   */
  httpRateLimit?: RateLimitOptions;
  /**
   * Separate, smaller throttle for WS frames (subscriptions, ping, pong).
   * `capacity: 0` disables it.
   */
  wsRateLimit?: RateLimitOptions;
}

/** Default HTTP budget: burst 12, sustained 6 requests/second. */
export const DEFAULT_HTTP_RATE_LIMIT: Required<RateLimitOptions> = {
  capacity: 12,
  refillPerSecond: 6,
  maxWaitMs: 30_000,
};

/** WS frames are subscription bookkeeping only: a smaller, separate budget. */
export const DEFAULT_WS_RATE_LIMIT: Required<RateLimitOptions> = {
  capacity: 8,
  refillPerSecond: 4,
  maxWaitMs: 10_000,
};

const CHALLENGE_SIGNATURES = [
  '<title>Just a moment...</title>',
  'window._cf_chl_opt',
  'Enable JavaScript and cookies to continue',
  'Checking your browser before accessing',
  'cf-browser-verification',
  'Cloudflare Ray ID',
];

const MAX_CLAIMED_IDS = 3000;
/** Response-contract issues kept in the transport ring buffer. */
export const MAX_CONTRACT_ISSUES = 50;
/** Zod issue paths recorded per drifted payload. */
const MAX_CONTRACT_ISSUE_PATHS = 5;
const CATCH_UP_MAX_AGE_MS = 10 * 60 * 1000;
/**
 * Last messages younger than this stay unclaimed on the initial chat fetch so that
 * `pollNewDeals` can still emit NEW_DEAL/ITEM_PAID for a deal paid right before start-up.
 */
const RECENT_LAST_MESSAGE_MS = 90_000;

function normalizeProxyUrl(proxy?: string): string | null {
  if (!proxy?.trim()) return null;
  const trimmed = proxy.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Transport/socket level failure (DNS, refused, reset, abort/timeout). */
function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && /^(E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(code)) return true;
  return /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|other side closed/i.test(
    error.message,
  );
}

/**
 * Maps a thrown outbound error to the counter bucket it belongs to.
 * `null` means "not an outbound failure" (e.g. a mapping bug) - it is left
 * uncounted instead of being mislabelled as a network problem.
 */
function classifyFailure(error: unknown): RequestFailureClass | null {
  if (!error) return null;
  if (error instanceof BotCheckDetectedError) return 'bot-check';
  if (error instanceof UnauthorizedError) return 'unauthorized';
  if (error instanceof RequestFailedError) return 'graphql';
  return isNetworkFailure(error) ? 'network' : null;
}

function mapUser(u: UserNode | null | undefined): UserProfile {
  return {
    id: String(u?.id ?? ''),
    username: String(u?.username ?? ''),
    role: (u?.role ?? null) as UserTypes | null,
    avatarUrl: u?.avatarURL ?? null,
    isOnline: Boolean(u?.isOnline),
    isBlocked: Boolean(u?.isBlocked),
    rating: u?.rating ?? null,
    reviewsCount: u?.testimonialCounter ?? u?.reviewsCount ?? null,
    supportChatId: u?.supportChatId ?? null,
    systemChatId: u?.systemChatId ?? null,
    createdAt: u?.createdAt ?? null,
  };
}

function mapChat(c: ChatNode | null | undefined): Chat {
  const rawUsers = c?.participants ?? c?.users ?? [];
  return {
    id: String(c?.id ?? ''),
    type: (c?.type as ChatTypes) ?? ChatTypes.PM,
    status: (c?.status ?? null) as ChatStatuses | null,
    unreadMessagesCounter: c?.unreadMessagesCounter ?? 0,
    users: Array.isArray(rawUsers) ? rawUsers.map(mapUser) : [],
    lastMessage: c?.lastMessage ? mapMessage(c.lastMessage) : null,
  };
}

function mapDeal(d: DealNode | EmbeddedDealNode | null | undefined): ItemDeal {
  const reviewRaw = d?.testimonial ?? d?.review;
  return {
    id: String(d?.id ?? ''),
    status: (d?.status as ItemDealStatuses) ?? ItemDealStatuses.PAID,
    direction: d?.direction as ItemDealDirections | undefined,
    createdAt: d?.createdAt ?? null,
    completedAt: d?.completedAt ?? null,
    hasProblem: Boolean(d?.hasProblem),
    commentFromBuyer: d?.commentFromBuyer ?? null,
    chatId: d?.chat?.id ? String(d.chat.id) : null,
    user: mapUser(d?.user),
    item: mapItem(d?.item),
    review: reviewRaw
      ? {
          id: String(reviewRaw.id ?? ''),
          status: (reviewRaw.status ?? null) as ReviewStatuses | null,
          rating: Number(reviewRaw.rating ?? 5),
          text: reviewRaw.text ?? null,
          createdAt: String(reviewRaw.createdAt ?? new Date().toISOString()),
          creator: mapUser(reviewRaw.creator),
          dealId: String(d?.id ?? ''),
        }
      : null,
  };
}

function mapItem(it: ItemNode | null | undefined): MyItem {
  return {
    id: String(it?.id ?? ''),
    slug: String(it?.slug ?? ''),
    name: String(it?.name ?? ''),
    description: it?.description ?? '',
    price: Number(it?.price ?? 0),
    rawPrice: Number(it?.rawPrice ?? it?.price ?? 0),
    priority: (it?.priority as PriorityTypes) ?? PriorityTypes.DEFAULT,
    status: (it?.status as ItemStatuses) ?? ItemStatuses.APPROVED,
    sequence: it?.sequence ?? null,
    mayBePublished: it?.mayBePublished ?? true,
    user: it?.user ? mapUser(it.user) : null,
    category: it?.category ? { id: String(it.category.id), name: it.category.name, slug: it.category.slug } : null,
    obtainingType: it?.obtainingType ? { id: String(it.obtainingType.id), name: it.obtainingType.name } : null,
    attributes: it?.attributes ?? {},
    dataFields: Array.isArray(it?.dataFields) ? (it.dataFields as DataField[]) : [],
    attachments: Array.isArray(it?.attachments) ? it.attachments : [],
  };
}

function mapMessage(m: ChatMessageNode | null | undefined): ChatMessage {
  return {
    id: String(m?.id ?? ''),
    text: m?.text ?? null,
    createdAt: String(m?.createdAt ?? new Date().toISOString()),
    isRead: Boolean(m?.isRead),
    user: mapUser(m?.user),
    images: Array.isArray(m?.images) ? m.images : m?.file ? [m.file] : undefined,
    deal: m?.deal ? mapDeal(m.deal) : null,
  };
}

function mapTransaction(t: TransactionNode | null | undefined): Transaction {
  return {
    id: String(t?.id ?? ''),
    operation: (t?.operation as TransactionOperations) ?? TransactionOperations.SELL,
    direction: (t?.direction as TransactionDirections) ?? TransactionDirections.IN,
    providerId: (t?.providerId ?? null) as TransactionProviderIds | null,
    status: (t?.status as TransactionStatuses) ?? TransactionStatuses.PENDING,
    value: Number(t?.value ?? 0),
    fee: t?.fee ?? undefined,
    createdAt: String(t?.createdAt ?? new Date().toISOString()),
    account: t?.props?.userData?.account ?? t?.account ?? null,
  };
}

/**
 * Standards-compliant HTTP GraphQL (persisted queries + mutations + multipart uploads)
 * and WebSocket (`graphql-transport-ws`) transport for PlayerOK.
 *
 * Includes:
 * - HTTP/HTTPS proxy support (undici ProxyAgent + HttpsProxyAgent)
 * - Per-chat `chatMessageCreated`, `chatUpdated`, and `userUpdated` WS subscriptions
 * - Automatic reconnect with exponential backoff + missed-message catch-up after disconnect
 * - New-deals HTTP polling fallback + delayed review checker (`reviewCheckDeals`)
 * - Clean detection of anti-bot challenges (BotCheckDetectedError) without bypassing them
 */
export class GraphQLPlayerokTransport implements PlayerokTransport {
  public readonly kind = 'graphql';

  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly cookieHeader: string;
  private readonly userAgent: string;
  private readonly proxyUrl: string | null;
  private readonly fetchDispatcher?: ProxyAgent;
  private readonly wsAgent?: HttpsProxyAgent<string>;
  private readonly timeoutMs: number;
  private readonly reviewPollIntervalMs: number;
  private readonly newDealsPollIntervalMs: number;
  private readonly wsPingIntervalMs: number;

  private accountId: string | null = null;
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reviewTimer: NodeJS.Timeout | null = null;
  private dealsPollTimer: NodeJS.Timeout | null = null;

  private wsReconnectAttempts = 0;
  private wsLastRecvAt = 0;
  private wsLostAt: number | null = null;
  private readonly knownChats = new Map<string, Chat>();
  private readonly chatSubIds = new Map<string, string>(); // subscriptionId -> chatId
  private readonly subscribedChatIds = new Set<string>();
  private readonly claimedMessageIds = new Set<string>();
  private readonly processedDealIds = new Set<string>();
  private readonly reviewCheckDeals = new Map<string, { lastCheck: number; tries: number }>();
  private readonly contractIssues: ContractIssue[] = [];

  private readonly httpLimiter: TokenBucket;
  private readonly wsLimiter: TokenBucket;
  private readonly requestCounts = new Map<string, number>();
  private readonly failureCounts: Record<RequestFailureClass, number> = {
    unauthorized: 0,
    'bot-check': 0,
    network: 0,
    graphql: 0,
  };
  private latencyTotalMs = 0;
  private latencyCount = 0;

  constructor(options: GraphQLTransportOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://playerok.com').replace(/\/+$/, '');
    this.wsUrl = options.wsUrl ?? 'wss://ws.playerok.com/graphql';
    const parsedCookies = parseCookieString(options.cookies);
    this.cookieHeader = Object.entries(parsedCookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    this.userAgent =
      options.userAgent || 'PlayerokHarness/2.0 (Node.js; standard HTTP/GraphQL client)';
    this.proxyUrl = normalizeProxyUrl(options.proxy);
    if (this.proxyUrl) {
      this.fetchDispatcher = new ProxyAgent(this.proxyUrl);
      this.wsAgent = new HttpsProxyAgent(this.proxyUrl);
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.reviewPollIntervalMs = options.reviewPollIntervalMs ?? 30_000;
    this.newDealsPollIntervalMs = options.newDealsPollIntervalMs ?? 15_000;
    this.wsPingIntervalMs = options.wsPingIntervalMs ?? 30_000;
    this.httpLimiter = new TokenBucket({
      ...DEFAULT_HTTP_RATE_LIMIT,
      ...options.httpRateLimit,
      name: 'playerok-http',
    });
    this.wsLimiter = new TokenBucket({
      ...DEFAULT_WS_RATE_LIMIT,
      ...options.wsRateLimit,
      name: 'playerok-ws',
    });
  }

  private baseHeaders(operationName: string): Record<string, string> {
    return {
      accept: '*/*',
      cookie: this.cookieHeader,
      origin: this.baseUrl,
      referer: `${this.baseUrl}/`,
      'user-agent': this.userAgent,
      'apollographql-client-name': 'web',
      'apollo-require-preflight': 'true',
      'x-apollo-operation-name': operationName,
      'x-gql-op': operationName,
      'x-gql-path': '/',
    };
  }

  private async fetchRaw(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (this.fetchDispatcher) {
        const resp = await undiciFetch(url, {
          ...(init as unknown as Parameters<typeof undiciFetch>[1]),
          signal: controller.signal,
          dispatcher: this.fetchDispatcher,
        });
        return resp as unknown as Response;
      }
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Single choke point for every outbound HTTP call: takes a token from the HTTP
   * bucket, then records the operation, its latency and (when it throws) the
   * failure class. A limiter rejection is not counted as a request - no HTTP
   * call was made.
   */
  private async track<T>(operation: string, run: () => Promise<T>): Promise<T> {
    await this.httpLimiter.acquire();
    const startedAt = performance.now();
    try {
      const result = await run();
      this.recordRequest(operation, startedAt, null);
      return result;
    } catch (error) {
      this.recordRequest(operation, startedAt, error);
      throw error;
    }
  }

  private recordRequest(operation: string, startedAt: number, error: unknown): void {
    this.requestCounts.set(operation, (this.requestCounts.get(operation) ?? 0) + 1);
    this.latencyTotalMs += Math.max(0, performance.now() - startedAt);
    this.latencyCount += 1;
    const failure = classifyFailure(error);
    if (failure) this.failureCounts[failure] += 1;
  }

  /**
   * Snapshot of outbound behaviour: requests per operation, failures per class,
   * total/count/average latency and the live throttle state. Safe to call at any
   * time; it does not mutate counters and does not consume tokens.
   */
  public getRequestStats(): RequestStats {
    let totalRequests = 0;
    for (const count of this.requestCounts.values()) totalRequests += count;
    return {
      requests: Object.fromEntries(this.requestCounts),
      failures: { ...this.failureCounts },
      totalRequests,
      latency: {
        totalMs: this.latencyTotalMs,
        count: this.latencyCount,
        averageMs: this.latencyCount > 0 ? this.latencyTotalMs / this.latencyCount : 0,
      },
      limiters: { http: this.httpLimiter.stats(), ws: this.wsLimiter.stats() },
    };
  }

  private parseGraphqlResponse<T>(resp: Response, bodyText: string, operationName: string): T {
    if (CHALLENGE_SIGNATURES.some((sig) => bodyText.includes(sig))) {
      throw new BotCheckDetectedError();
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new UnauthorizedError(`HTTP ${resp.status} при запросе ${operationName}`);
    }
    if (!resp.ok) {
      throw new RequestFailedError(resp.status, `GraphQL HTTP ${resp.status} (${operationName})`, bodyText);
    }

    let json: { data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }> };
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new RequestFailedError(resp.status, `Некорректный JSON от PlayerOK (${operationName})`, bodyText);
    }

    if (json.errors && json.errors.length > 0) {
      const first = json.errors[0];
      if (first.extensions?.code === 'UNAUTHENTICATED') {
        throw new UnauthorizedError(first.message);
      }
      throw new RequestFailedError(resp.status, `GraphQL error (${operationName}): ${first.message}`);
    }
    if (!json.data) {
      throw new RequestFailedError(resp.status, `Пустой ответ GraphQL (${operationName})`);
    }
    return json.data;
  }

  /**
   * Validates a raw GraphQL/WS payload against the response contract.
   *
   * On drift it records a bounded issue (operation + first Zod issue paths) and
   * returns the raw payload cast to the schema type. Mapping therefore stays
   * best-effort exactly as before - the guard only makes the drift observable
   * instead of letting a renamed field silently become `undefined`/`''`/`0`.
   */
  private guard<T>(op: string, schema: z.ZodType<T>, data: unknown): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      this.recordContractIssue({
        op,
        paths: parsed.error.issues.slice(0, MAX_CONTRACT_ISSUE_PATHS).map((issue) =>
          issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join('.') : '(root)',
        ),
        issueCount: parsed.error.issues.length,
        at: new Date().toISOString(),
      });
    }
    return data as T;
  }

  /** Appends to the bounded ring buffer (oldest issue dropped first). */
  private recordContractIssue(issue: ContractIssue): void {
    this.contractIssues.push(issue);
    while (this.contractIssues.length > MAX_CONTRACT_ISSUES) {
      this.contractIssues.shift();
    }
  }

  /** Recent response-contract issues observed at the GraphQL/WS boundary. */
  public getContractIssues(): ContractIssue[] {
    return this.contractIssues.slice();
  }

  /**
   * Executes a persisted GET GraphQL query matching PlayerOK's Apollo APQ protocol.
   */
  private persistedQuery<T>(
    operationName: keyof typeof PERSISTED_QUERIES,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    return this.track(operationName, async () => {
      const params = new URLSearchParams({
        operationName,
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: {
            version: 1,
            sha256Hash: PERSISTED_QUERIES[operationName],
          },
        }),
      });
      const url = `${this.baseUrl}/graphql?${params.toString()}`;
      const resp = await this.fetchRaw(url, {
        method: 'GET',
        headers: this.baseHeaders(operationName),
      });
      const bodyText = await resp.text();
      return this.parseGraphqlResponse<T>(resp, bodyText, operationName);
    });
  }

  /**
   * Executes a POST GraphQL query/mutation.
   */
  private postQuery<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    return this.track(operationName, async () => {
      const resp = await this.fetchRaw(`${this.baseUrl}/graphql`, {
        method: 'POST',
        headers: {
          ...this.baseHeaders(operationName),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operationName, query, variables }),
      });
      const bodyText = await resp.text();
      return this.parseGraphqlResponse<T>(resp, bodyText, operationName);
    });
  }

  /**
   * Executes a GraphQL multipart file upload mutation (Apollo Upload spec).
   */
  private postMultipart<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    filesMap: Record<string, { path: string[]; file: BinaryUpload }>,
  ): Promise<T> {
    return this.track(operationName, async () => {
      const form = new FormData();
      const map: Record<string, string[]> = {};
      for (const [fieldKey, entry] of Object.entries(filesMap)) {
        map[fieldKey] = entry.path;
      }
      form.append('operations', JSON.stringify({ operationName, query, variables }));
      form.append('map', JSON.stringify(map));

      for (const [fieldKey, entry] of Object.entries(filesMap)) {
        const blob = new Blob([new Uint8Array(entry.file.data)], {
          type: entry.file.contentType || 'application/octet-stream',
        });
        form.append(fieldKey, blob, entry.file.filename);
      }

      const resp = await this.fetchRaw(`${this.baseUrl}/graphql`, {
        method: 'POST',
        headers: this.baseHeaders(operationName),
        body: form,
      });
      const bodyText = await resp.text();
      return this.parseGraphqlResponse<T>(resp, bodyText, operationName);
    });
  }

  public async getAccount(): Promise<AccountInfo> {
    const viewerData = this.guard(
      'viewer',
      viewerPayloadSchema,
      await this.postQuery<unknown>('viewer', GQL_QUERIES.viewer, {}),
    );
    const v = viewerData.viewer;
    if (!v) {
      throw new UnauthorizedError('viewer вернул null — проверьте cookies');
    }
    this.accountId = String(v.id);

    let fullUser: UserNode | null = null;
    try {
      const userData = this.guard(
        'user',
        userPayloadSchema,
        await this.persistedQuery<unknown>('user', {
          username: v.username,
          hasSupportAccess: false,
        }),
      );
      fullUser = userData.user;
    } catch {
      // Fallback to viewer-only fields if persisted user query fails
    }

    const profileRaw: ProfileNode = fullUser?.profile ?? v.profile ?? {};
    const balanceRaw = fullUser?.balance ?? v.balance ?? null;
    const statsRaw = fullUser?.stats ?? profileRaw.stats ?? null;

    return {
      id: String(v.id),
      username: String(v.username ?? ''),
      email: v.email ?? null,
      role: v.role ?? null,
      supportChatId: v.supportChatId ?? null,
      systemChatId: v.systemChatId ?? null,
      unreadChatsCounter: v.unreadChatsCounter ?? 0,
      isBlocked: Boolean(v.isBlocked),
      isBlockedFor: v.isBlockedFor ?? null,
      createdAt: v.createdAt ?? null,
      hasFrozenBalance: Boolean(v.hasFrozenBalance),
      hasConfirmedPhoneNumber: Boolean(v.hasConfirmedPhoneNumber),
      canPublishItems: Boolean(v.canPublishItems ?? true),
      profile: {
        id: String(profileRaw.id ?? v.id),
        username: String(fullUser?.username ?? v.username ?? ''),
        avatarUrl: profileRaw.avatarURL ?? null,
        isOnline: Boolean(fullUser?.isOnline ?? true),
        isBlocked: Boolean(fullUser?.isBlocked ?? v.isBlocked),
        rating: profileRaw.rating ?? fullUser?.rating ?? null,
        reviewsCount: profileRaw.testimonialCounter ?? fullUser?.testimonialCounter ?? null,
        balance: balanceRaw
          ? {
              id: String(balanceRaw.id ?? ''),
              value: Number(balanceRaw.value ?? 0),
              frozen: Number(balanceRaw.frozen ?? 0),
              available: Number(balanceRaw.available ?? balanceRaw.value ?? 0),
              withdrawable: Number(balanceRaw.withdrawable ?? balanceRaw.available ?? 0),
              pendingIncome: Number(balanceRaw.pendingIncome ?? 0),
            }
          : null,
        stats: statsRaw ?? null,
      },
    };
  }

  public async getUser(userId: string): Promise<UserProfile> {
    const data = this.guard(
      'user',
      userPayloadSchema,
      await this.persistedQuery<unknown>('user', {
        id: userId,
        username: null,
        hasSupportAccess: false,
      }),
    );
    const raw =
      data.user?.__typename === 'User'
        ? { ...data.user, ...(data.user.profile ?? {}) }
        : data.user;
    // The profile spread may shadow `id` with its nullable twin; runtime ids are
    // identical, and `mapUser` coerces whatever survives with `String()`.
    return mapUser(raw as UserNode | null | undefined);
  }

  public async getChats(count = 24, afterCursor?: string | null): Promise<PaginatedList<Chat>> {
    const data = this.guard(
      'userChats',
      chatsPayloadSchema,
      await this.persistedQuery<unknown>('userChats', {
        pagination: { first: count, after: afterCursor ?? null },
        filter: { userId: this.accountId, type: null, status: null },
        hasSupportAccess: false,
      }),
    );
    return {
      items: (data.chats?.edges ?? []).map((e) => mapChat(e.node)),
      pageInfo: {
        endCursor: data.chats?.pageInfo?.endCursor ?? null,
        hasNextPage: Boolean(data.chats?.pageInfo?.hasNextPage),
      },
    };
  }

  public async getChat(chatId: string): Promise<Chat> {
    const data = this.guard(
      'chat',
      chatPayloadSchema,
      await this.persistedQuery<unknown>('chat', {
        id: chatId,
        hasSupportAccess: false,
      }),
    );
    return mapChat(data.chat);
  }

  public async getChatMessages(chatId: string, count = 24): Promise<ChatMessage[]> {
    const data = this.guard(
      'chatMessages',
      chatMessagesPayloadSchema,
      await this.persistedQuery<unknown>('chatMessages', {
        pagination: { first: count, after: null },
        filter: { chatId },
        hasSupportAccess: false,
        showForbiddenImage: true,
      }),
    );
    return (data.chatMessages?.edges ?? []).map((e) => mapMessage(e.node));
  }

  public async markChatAsRead(chatId: string): Promise<void> {
    await this.postQuery('markChatAsRead', GQL_QUERIES.markChatAsRead, {
      input: { chatId },
    });
  }

  public downloadFile(url: string): Promise<Buffer> {
    return this.track('downloadFile', async () => {
      const resp = await this.fetchRaw(url, {
        method: 'GET',
        headers: { 'user-agent': this.userAgent },
      });
      if (!resp.ok) {
        throw new RequestFailedError(resp.status, `Не удалось скачать файл ${url}: HTTP ${resp.status}`);
      }
      return Buffer.from(await resp.arrayBuffer());
    });
  }

  private async uploadChatImage(chatId: string, file: BinaryUpload): Promise<string> {
    const data = this.guard(
      'uploadChatImageIntoTemporaryStore',
      uploadChatImagePayloadSchema,
      await this.postMultipart<unknown>(
        'uploadChatImageIntoTemporaryStore',
        GQL_QUERIES.uploadChatImageIntoTemporaryStore,
        {
          file: null,
          input: {
            chatId,
            clientAttachmentId: crypto.randomUUID(),
          },
        },
        { '1': { path: ['variables.file'], file } },
      ),
    );
    const uploadedId = data.uploadChatImageIntoTemporaryStore?.id;
    if (!uploadedId) {
      // No best-effort fallback exists: without an upload id the attachment silently
      // disappears from the message, so the caller must see a real failure.
      throw new RequestFailedError(
        200,
        'PlayerOK не вернул идентификатор загруженного изображения (контракт uploadChatImageIntoTemporaryStore нарушен)',
      );
    }
    return String(uploadedId);
  }

  public async sendMessage(params: SendMessageParams): Promise<ChatMessage> {
    if (params.markChatAsRead) {
      await this.markChatAsRead(params.chatId).catch(() => {});
    }

    const imagesIds: string[] = [];
    for (const img of params.images ?? []) {
      const id = await this.uploadChatImage(params.chatId, img);
      imagesIds.push(id);
    }

    const data = this.guard(
      'createChatMessage',
      createChatMessagePayloadSchema,
      await this.postQuery<unknown>('createChatMessage', GQL_QUERIES.createChatMessage, {
        input: {
          chatId: params.chatId,
          imagesIds,
          text: params.text ?? '',
        },
      }),
    );
    return mapMessage(data.createChatMessage);
  }

  public async getMyItems(params: GetMyItemsParams = {}): Promise<PaginatedList<MyItem>> {
    const filter: Record<string, unknown> = {
      userId: this.accountId,
      status: params.statuses && params.statuses.length > 0 ? params.statuses : null,
    };
    if (params.gameId) filter.gameId = params.gameId;
    else if (params.categoryId) filter.gameCategoryId = params.categoryId;
    if (params.obtainingTypeId) filter.obtainingTypeId = params.obtainingTypeId;

    const data = this.guard(
      'items',
      itemsPayloadSchema,
      await this.persistedQuery<unknown>('items', {
        pagination: { first: params.count ?? 24, after: params.afterCursor ?? null },
        filter,
        showForbiddenImage: true,
      }),
    );
    return {
      items: (data.items?.edges ?? []).map((e) => mapItem(e.node)),
      pageInfo: {
        endCursor: data.items?.pageInfo?.endCursor ?? null,
        hasNextPage: Boolean(data.items?.pageInfo?.hasNextPage),
      },
    };
  }

  public async getItem(ref: { id?: string; slug?: string }): Promise<MyItem> {
    const data = this.guard(
      'item',
      itemPayloadSchema,
      await this.persistedQuery<unknown>('item', {
        id: ref.id ?? null,
        slug: ref.slug ?? null,
        hasSupportAccess: false,
        showForbiddenImage: true,
      }),
    );
    return mapItem(data.item);
  }

  public async getItemPriorityStatuses(itemId: string, rawPrice: number): Promise<ItemPriorityStatus[]> {
    const data = this.guard(
      'itemPriorityStatuses',
      itemPriorityStatusesPayloadSchema,
      await this.persistedQuery<unknown>('itemPriorityStatuses', {
        itemId,
        price: Math.trunc(rawPrice),
      }),
    );
    return (data.itemPriorityStatuses ?? []).map((st) => ({
      id: String(st.id),
      name: String(st.name ?? ''),
      price: Number(st.price ?? 0),
      type: (st.type as PriorityTypes) ?? PriorityTypes.DEFAULT,
      period: st.period ?? undefined,
    }));
  }

  public async increaseItemPriorityStatus(itemId: string, priorityStatusId: string): Promise<MyItem> {
    const data = this.guard(
      'increaseItemPriorityStatus',
      increaseItemPriorityStatusPayloadSchema,
      await this.postQuery<unknown>('increaseItemPriorityStatus', GQL_QUERIES.increaseItemPriorityStatus, {
        input: {
          itemId,
          priorityStatuses: [priorityStatusId],
          transactionProviderData: { paymentMethodId: null },
          transactionProviderId: TransactionProviderIds.LOCAL,
        },
      }),
    );
    return mapItem(data.increaseItemPriorityStatus);
  }

  public async publishItem(itemId: string, priorityStatusId: string): Promise<MyItem> {
    const data = this.guard(
      'publishItem',
      publishItemPayloadSchema,
      await this.postQuery<unknown>('publishItem', GQL_QUERIES.publishItem, {
        input: {
          transactionProviderId: TransactionProviderIds.LOCAL,
          priorityStatuses: [priorityStatusId],
          itemId,
        },
      }),
    );
    return mapItem(data.publishItem);
  }

  public async createItem(params: CreateItemParams): Promise<MyItem> {
    const attachments = params.attachments ?? [];
    const variables = {
      input: {
        gameCategoryId: params.gameCategoryId,
        obtainingTypeId: params.obtainingTypeId,
        name: params.name,
        price: params.price,
        description: params.description,
        attributes: params.options ?? {},
        dataFields: (params.dataFields ?? []).map((f) => ({ fieldId: f.id, value: f.value })),
      },
      attachments: attachments.map(() => null),
    };

    if (attachments.length > 0) {
      const filesMap: Record<string, { path: string[]; file: BinaryUpload }> = {};
      attachments.forEach((file, idx) => {
        filesMap[String(idx + 1)] = { path: [`variables.attachments.${idx}`], file };
      });
      const data = this.guard(
        'createItem',
        createItemPayloadSchema,
        await this.postMultipart<unknown>('createItem', GQL_QUERIES.createItem, variables, filesMap),
      );
      return mapItem(data.createItem);
    }

    const data = this.guard(
      'createItem',
      createItemPayloadSchema,
      await this.postQuery<unknown>('createItem', GQL_QUERIES.createItem, variables),
    );
    return mapItem(data.createItem);
  }

  public async updateItem(itemId: string, params: UpdateItemParams): Promise<MyItem> {
    const input: Record<string, unknown> = { id: itemId };
    if (params.name !== undefined) input.name = params.name;
    if (params.price !== undefined) input.price = params.price;
    if (params.description !== undefined) input.description = params.description;
    if (params.dataFields !== undefined) {
      input.dataFields = params.dataFields.map((f) => ({ fieldId: f.id, value: f.value }));
    }
    const data = this.guard(
      'updateItem',
      updateItemPayloadSchema,
      await this.postQuery<unknown>('updateItem', GQL_QUERIES.updateItem, { input }),
    );
    return mapItem(data.updateItem);
  }

  public async removeItem(itemId: string): Promise<boolean> {
    await this.postQuery('removeItem', GQL_QUERIES.removeItem, { id: itemId });
    return true;
  }

  public async getDeals(params: GetDealsParams = {}): Promise<PaginatedList<ItemDeal>> {
    const data = this.guard(
      'deals',
      dealsPayloadSchema,
      await this.persistedQuery<unknown>('deals', {
        pagination: { first: params.count ?? 24, after: params.afterCursor ?? null },
        filter: {
          userId: this.accountId,
          direction: params.direction ?? null,
          status: params.statuses && params.statuses.length > 0 ? params.statuses : null,
        },
        showForbiddenImage: true,
      }),
    );
    return {
      items: (data.deals?.edges ?? []).map((e) => mapDeal(e.node)),
      pageInfo: {
        endCursor: data.deals?.pageInfo?.endCursor ?? null,
        hasNextPage: Boolean(data.deals?.pageInfo?.hasNextPage),
      },
    };
  }

  public async getDeal(dealId: string): Promise<ItemDeal> {
    const data = this.guard(
      'deal',
      dealPayloadSchema,
      await this.persistedQuery<unknown>('deal', {
        id: dealId,
        hasSupportAccess: false,
        showForbiddenImage: true,
      }),
    );
    return mapDeal(data.deal);
  }

  public async updateDeal(dealId: string, status: ItemDealStatuses): Promise<ItemDeal> {
    const data = this.guard(
      'updateDeal',
      updateDealPayloadSchema,
      await this.postQuery<unknown>('updateDeal', GQL_QUERIES.updateDeal, {
        input: { id: dealId, status },
      }),
    );
    return mapDeal(data.updateDeal);
  }

  public async reportDealProblem(dealId: string, description: string, problemTypeId: string): Promise<ItemDeal> {
    const data = this.guard(
      'reportDealProblem',
      reportDealProblemPayloadSchema,
      await this.postQuery<unknown>('reportDealProblem', GQL_QUERIES.reportDealProblem, {
        input: { dealId, description, problemTypeId },
      }),
    );
    return mapDeal(data.reportDealProblem);
  }

  public async getReviews(params: GetReviewsParams = {}): Promise<PaginatedList<Review>> {
    const filter: Record<string, unknown> = {
      userId: this.accountId,
      hasComment: Boolean(params.commentRequired),
      status: [ReviewStatuses.APPROVED],
    };
    if (params.rating) filter.rating = params.rating;

    const data = this.guard(
      'testimonials',
      reviewsPayloadSchema,
      await this.persistedQuery<unknown>('testimonials', {
        pagination: { first: params.count ?? 24, after: params.afterCursor ?? null },
        filter,
        sort: { direction: SortDirections.DESC, field: 'createdAt' },
        hasSupportAccess: false,
      }),
    );
    return {
      items: (data.testimonials?.edges ?? []).map((e) => ({
        id: String(e.node.id),
        rating: Number(e.node.rating ?? 5),
        text: e.node.text ?? null,
        createdAt: String(e.node.createdAt ?? new Date().toISOString()),
        status: (e.node.status ?? null) as ReviewStatuses | null,
        creator: mapUser(e.node.creator),
      })),
      pageInfo: {
        endCursor: data.testimonials?.pageInfo?.endCursor ?? null,
        hasNextPage: Boolean(data.testimonials?.pageInfo?.hasNextPage),
      },
    };
  }

  public async getTransactions(count = 24, afterCursor?: string | null): Promise<PaginatedList<Transaction>> {
    const data = this.guard(
      'transactions',
      transactionsPayloadSchema,
      await this.persistedQuery<unknown>('transactions', {
        pagination: { first: count, after: afterCursor ?? null },
        filter: { userId: this.accountId },
      }),
    );
    return {
      items: (data.transactions?.edges ?? []).map((e) => mapTransaction(e.node)),
      pageInfo: {
        endCursor: data.transactions?.pageInfo?.endCursor ?? null,
        hasNextPage: Boolean(data.transactions?.pageInfo?.hasNextPage),
      },
    };
  }

  public async getSbpBankMembers(): Promise<SbpBankMember[]> {
    const data = this.guard(
      'SbpBankMembers',
      sbpBankMembersPayloadSchema,
      await this.persistedQuery<unknown>('SbpBankMembers', {}),
    );
    return (data.sbpBankMembers ?? []).map((m) => ({
      id: String(m.id),
      name: String(m.name ?? ''),
      icon: m.icon ?? null,
    }));
  }

  public async getVerifiedCards(): Promise<VerifiedCard[]> {
    const data = this.guard(
      'verifiedCards',
      verifiedCardsPayloadSchema,
      await this.persistedQuery<unknown>('verifiedCards', {
        pagination: { first: 24, after: null },
        sort: { direction: SortDirections.ASC },
        field: 'createdAt',
      }),
    );
    const payload = data.verifiedCards;
    // Both shapes the mapper has always accepted: a paginated connection and a bare array.
    const nodes: VerifiedCardNode[] = Array.isArray(payload)
      ? payload
      : payload && Array.isArray(payload.edges)
        ? payload.edges.map((edge) => edge.node)
        : [];
    return nodes.map((c) => ({
      id: String(c.id),
      cardFirstSix: String(c.cardFirstSix ?? ''),
      cardLastFour: String(c.cardLastFour ?? ''),
      cardType: c.cardType ?? null,
      isChosen: Boolean(c.isChosen),
    }));
  }

  public async requestWithdrawal(params: RequestWithdrawalParams): Promise<Transaction> {
    const data = this.guard(
      'requestWithdrawal',
      requestWithdrawalPayloadSchema,
      await this.postQuery<unknown>('requestWithdrawal', GQL_QUERIES.requestWithdrawal, {
        input: {
          provider: params.provider,
          account: params.account,
          value: params.value,
          providerData: {
            paymentMethodId: null,
            sbpBankMemberId: params.sbpBankMemberId ?? null,
          },
        },
      }),
    );
    return mapTransaction(data.requestWithdrawal);
  }

  public async removeTransaction(transactionId: string): Promise<Transaction> {
    const data = this.guard(
      'removeTransaction',
      removeTransactionPayloadSchema,
      await this.postQuery<unknown>('removeTransaction', GQL_QUERIES.removeTransaction, {
        id: transactionId,
      }),
    );
    return mapTransaction(data.removeTransaction);
  }

  private claimMessageId(id: string): boolean {
    if (!id || this.claimedMessageIds.has(id)) return false;
    this.claimedMessageIds.add(id);
    if (this.claimedMessageIds.size > MAX_CLAIMED_IDS) {
      const oldest = this.claimedMessageIds.values().next().value;
      if (oldest) this.claimedMessageIds.delete(oldest);
    }
    return true;
  }

  /**
   * Remembers a deal that already produced NEW_DEAL/ITEM_PAID events.
   * Bounded like `claimedMessageIds` so a long-running bot does not grow this set forever.
   */
  private claimDealId(dealId: string): boolean {
    if (!dealId || this.processedDealIds.has(dealId)) return false;
    this.processedDealIds.add(dealId);
    if (this.processedDealIds.size > MAX_CLAIMED_IDS) {
      const oldest = this.processedDealIds.values().next().value;
      if (oldest) this.processedDealIds.delete(oldest);
    }
    return true;
  }

  private async mapMessageToEvents(message: ChatMessage, chat: Chat): Promise<PlayerokEvent[]> {
    const now = Date.now();
    if (!message.text) {
      if (!message.images || message.images.length === 0) return [];
      return [{ type: EventTypes.NEW_MESSAGE, chat, message: { ...message, text: null }, timestamp: now }];
    }

    const token = message.text.trim();
    if (token === '{{ITEM_PAID}}' && message.deal?.id) {
      const deal = await this.getDeal(message.deal.id).catch(() => message.deal!);
      if (!this.claimDealId(deal.id)) return [];
      if (!this.reviewCheckDeals.has(deal.id)) {
        this.reviewCheckDeals.set(deal.id, { lastCheck: 0, tries: 0 });
      }
      return [
        { type: EventTypes.NEW_DEAL, chat, deal, timestamp: now },
        { type: EventTypes.ITEM_PAID, chat, deal, timestamp: now },
      ];
    }
    if (token === '{{ITEM_SENT}}' && message.deal?.id) {
      const deal = await this.getDeal(message.deal.id).catch(() => message.deal!);
      return [
        { type: EventTypes.ITEM_SENT, chat, deal, timestamp: now },
        { type: EventTypes.DEAL_STATUS_CHANGED, chat, deal, timestamp: now },
      ];
    }
    if (token === '{{DEAL_CONFIRMED}}' && message.deal?.id) {
      const deal = await this.getDeal(message.deal.id).catch(() => message.deal!);
      return [
        { type: EventTypes.DEAL_CONFIRMED, chat, deal, timestamp: now },
        { type: EventTypes.DEAL_STATUS_CHANGED, chat, deal, timestamp: now },
      ];
    }
    if (token === '{{DEAL_CONFIRMED_AUTOMATICALLY}}' && message.deal?.id) {
      const deal = await this.getDeal(message.deal.id).catch(() => message.deal!);
      return [
        { type: EventTypes.DEAL_CONFIRMED_AUTOMATICALLY, chat, deal, timestamp: now },
        { type: EventTypes.DEAL_STATUS_CHANGED, chat, deal, timestamp: now },
      ];
    }
    if (token === '{{DEAL_ROLLED_BACK}}' && message.deal?.id) {
      const deal = await this.getDeal(message.deal.id).catch(() => message.deal!);
      return [
        { type: EventTypes.DEAL_ROLLED_BACK, chat, deal, timestamp: now },
        { type: EventTypes.DEAL_STATUS_CHANGED, chat, deal, timestamp: now },
      ];
    }
    if (token === '{{DEAL_HAS_PROBLEM}}' && message.deal?.id) {
      const deal = await this.getDeal(message.deal.id).catch(() => message.deal!);
      return [{ type: EventTypes.DEAL_HAS_PROBLEM, chat, deal, timestamp: now }];
    }
    if (token === '{{DEAL_PROBLEM_RESOLVED}}' && message.deal?.id) {
      const deal = await this.getDeal(message.deal.id).catch(() => message.deal!);
      return [{ type: EventTypes.DEAL_PROBLEM_RESOLVED, chat, deal, timestamp: now }];
    }

    return [{ type: EventTypes.NEW_MESSAGE, chat, message, timestamp: now }];
  }

  /**
   * Sends one WS frame through the WS bucket. Returns `false` when the socket is
   * no longer open (nothing was sent); throws only when the limiter itself
   * rejects (closed transport / max wait), which callers roll back on.
   */
  private async sendWs(
    ws: WebSocket,
    payload: Record<string, unknown>,
    operation: string,
  ): Promise<boolean> {
    await this.wsLimiter.acquire();
    if (ws.readyState !== WebSocket.OPEN) return false;
    const startedAt = performance.now();
    try {
      ws.send(JSON.stringify(payload));
      this.recordRequest(operation, startedAt, null);
      return true;
    } catch (error) {
      this.recordRequest(operation, startedAt, error);
      return false;
    }
  }

  private async subscribeChatMessages(chatId: string): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (this.subscribedChatIds.has(chatId)) return;
    const subId = `msg-${chatId}-${crypto.randomUUID().slice(0, 6)}`;
    this.subscribedChatIds.add(chatId);
    this.chatSubIds.set(subId, chatId);
    try {
      const sent = await this.sendWs(
        ws,
        {
          id: subId,
          type: 'subscribe',
          payload: {
            operationName: 'chatMessageCreated',
            query: GQL_QUERIES.chatMessageCreated,
            variables: { filter: { chatId } },
          },
        },
        'ws:subscribe',
      );
      if (sent) return;
    } catch {
      // Limiter closed or timed out: fall through and roll back.
    }
    // Roll back so the chat is not considered subscribed on a dead socket
    // (otherwise it is never re-subscribed until the next reconnect).
    this.subscribedChatIds.delete(chatId);
    this.chatSubIds.delete(subId);
  }

  /**
   * Catches up messages that arrived during a WebSocket disconnect window (up to 10 minutes).
   *
   * @returns `false` when the chat list could not be fetched — the caller must then keep the
   * disconnect window armed so the catch-up is retried on the next reconnect instead of being
   * silently lost.
   */
  public async catchUpMessages(sinceMs: number, handler: PlayerokEventHandler): Promise<boolean> {
    const cutoff = Math.max(sinceMs, Date.now() - CATCH_UP_MAX_AGE_MS);
    let list: PaginatedList<Chat>;
    try {
      list = await this.getChats(15);
    } catch {
      return false;
    }
    for (const chat of list.items) {
      this.knownChats.set(chat.id, chat);
      let messages: ChatMessage[];
      try {
        messages = await this.getChatMessages(chat.id, 12);
      } catch {
        continue;
      }
      const chronological = [...messages].sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
      );
      for (const msg of chronological) {
        const ts = Date.parse(msg.createdAt);
        if (Number.isNaN(ts) || ts < cutoff) continue;
        // Our own outgoing messages are not incoming events (deal placeholders excepted).
        if (this.accountId && msg.user?.id === this.accountId && !(msg.text ?? '').startsWith('{{')) {
          continue;
        }
        if (!this.claimMessageId(msg.id)) continue;
        const events = await this.mapMessageToEvents(msg, chat);
        for (const ev of events) {
          try {
            await handler(ev);
          } catch {
            // a failing handler must not abort the rest of the catch-up
          }
        }
      }
    }
    return true;
  }

  /**
   * Polls recently paid deals in case a buyer message overwrote `lastMessage` before WS subscribed.
   */
  public async pollNewDeals(handler: PlayerokEventHandler): Promise<void> {
    const cutoff = Date.now() - RECENT_LAST_MESSAGE_MS;
    try {
      const list = await this.getChats(15);
      for (const chat of list.items) {
        const isKnown = this.knownChats.has(chat.id);
        this.knownChats.set(chat.id, chat);
        if (!isKnown) {
          void this.subscribeChatMessages(chat.id).catch(() => {});
        }
        const last = chat.lastMessage;
        if (!last) continue;
        const lastTs = Date.parse(last.createdAt);
        if (!Number.isNaN(lastTs) && lastTs >= cutoff && last.text === '{{ITEM_PAID}}') {
          if (this.claimMessageId(last.id)) {
            const events = await this.mapMessageToEvents(last, chat);
            for (const ev of events) await handler(ev);
          }
        }
      }
    } catch {
      // non-fatal poll
    }
  }

  /**
   * Periodically inspects deals awaiting buyer reviews and emits NEW_REVIEW when a review appears.
   */
  public async pollPendingReviews(handler: PlayerokEventHandler): Promise<void> {
    const now = Date.now();
    for (const [dealId, info] of Array.from(this.reviewCheckDeals.entries())) {
      if (now - info.lastCheck < this.reviewPollIntervalMs) continue;
      if (info.tries >= 30) {
        this.reviewCheckDeals.delete(dealId);
        continue;
      }
      info.lastCheck = now;
      info.tries += 1;

      try {
        const deal = await this.getDeal(dealId);
        if (deal.review) {
          this.reviewCheckDeals.delete(dealId);
          const chat =
            (deal.chatId && this.knownChats.get(deal.chatId)) ||
            (deal.chatId ? await this.getChat(deal.chatId).catch(() => null) : null) || {
              id: deal.chatId ?? '',
              type: ChatTypes.PM,
              users: [deal.user],
            };
          await handler({
            type: EventTypes.NEW_REVIEW,
            chat,
            deal,
            timestamp: Date.now(),
          });
        }
      } catch {
        // retry on next tick
      }
    }
  }

  public async subscribe(handler: PlayerokEventHandler): Promise<() => void> {
    this.closed = false;
    // A transport that was closed and is subscribed again must accept traffic
    // again; without this every acquire would reject with RateLimitClosedError.
    this.httpLimiter.reopen();
    this.wsLimiter.reopen();

    // Seed initial chats & emit CHAT_INITIALIZED
    try {
      const initial = await this.getChats(24);
      const recentCutoff = Date.now() - RECENT_LAST_MESSAGE_MS;
      for (const chat of initial.items) {
        this.knownChats.set(chat.id, chat);
        // Only pre-claim stale last messages: a recent one (a deal paid moments before start-up)
        // must stay unclaimed so pollNewDeals can still emit NEW_DEAL/ITEM_PAID for it.
        if (chat.lastMessage?.id) {
          const lastTs = Date.parse(chat.lastMessage.createdAt);
          if (!(lastTs >= recentCutoff)) this.claimMessageId(chat.lastMessage.id);
        }
        await handler({
          type: EventTypes.CHAT_INITIALIZED,
          chat,
          timestamp: Date.now(),
        });
      }
    } catch {
      // continue to WS even if initial chat list fails
    }

    const connectWs = () => {
      if (this.closed) return;
      this.subscribedChatIds.clear();
      this.chatSubIds.clear();

      const ws = new WebSocket(this.wsUrl, 'graphql-transport-ws', {
        headers: {
          cookie: this.cookieHeader,
          origin: this.baseUrl,
          'user-agent': this.userAgent,
        },
        agent: this.wsAgent,
        handshakeTimeout: 15_000,
      });
      this.ws = ws;

      ws.on('open', () => {
        void this.sendWs(ws, { type: 'connection_init', payload: {} }, 'ws:connection_init').catch(
          () => {},
        );
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            void this.sendWs(ws, { type: 'ping' }, 'ws:ping').catch(() => {});
          }
        }, this.wsPingIntervalMs);
        this.pingTimer.unref?.();
      });

      // The whole handler body is wrapped in try/catch, so its promise never rejects.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      ws.on('message', async (raw) => {
        this.wsLastRecvAt = Date.now();
        try {
          const msg = JSON.parse(raw.toString()) as { id?: string; type: string; payload?: any };
          if (msg.type === 'ping') {
            await this.sendWs(ws, { type: 'pong' }, 'ws:pong');
            return;
          }
          if (msg.type === 'pong') return;

          if (msg.type === 'error' || msg.type === 'complete') {
            // A rejected/finished subscription used to stay in subscribedChatIds forever,
            // so the chat was never re-subscribed and went permanently deaf.
            const chatId = msg.id ? this.chatSubIds.get(msg.id) : undefined;
            if (chatId && msg.id) {
              this.chatSubIds.delete(msg.id);
              this.subscribedChatIds.delete(chatId);
            }
            return;
          }

          if (msg.type === 'connection_ack') {
            this.wsReconnectAttempts = 0;

            if (this.accountId) {
              await this.sendWs(
                ws,
                {
                  id: 'user-updated',
                  type: 'subscribe',
                  payload: {
                    operationName: 'userUpdated',
                    query: GQL_QUERIES.userUpdated,
                    variables: { userId: this.accountId },
                  },
                },
                'ws:subscribe',
              );
            }
            await this.sendWs(
              ws,
              {
                id: 'chat-updated',
                type: 'subscribe',
                payload: {
                  operationName: 'chatUpdated',
                  query: GQL_QUERIES.chatUpdated,
                  variables: { filter: this.accountId ? { userId: this.accountId } : undefined },
                },
              },
              'ws:subscribe',
            );
            for (const chatId of this.knownChats.keys()) {
              await this.subscribeChatMessages(chatId);
            }

            if (this.wsLostAt !== null) {
              const lostAt = this.wsLostAt;
              // Keep the window armed until the catch-up actually succeeded, otherwise a single
              // failed listing right after reconnect would drop every missed message for good.
              const caughtUp = await this.catchUpMessages(lostAt, handler);
              if (caughtUp && this.wsLostAt === lostAt) this.wsLostAt = null;
            }
            return;
          }

          if (msg.type === 'next' && msg.payload?.data) {
            // Guard the whole WS frame: a renamed subscription key must be reported
            // rather than silently ignored, and `chatMessageCreated` is validated in full.
            const data = this.guard('ws:next', wsNextPayloadSchema, msg.payload.data);

            if ((data.userUpdated?.unreadChatsCounter ?? 0) > 0) {
              void this.pollNewDeals(handler);
            }

            if (data.chatUpdated) {
              const chat = mapChat(data.chatUpdated);
              const existed = this.knownChats.has(chat.id);
              this.knownChats.set(chat.id, chat);
              if (!existed) {
                void this.subscribeChatMessages(chat.id).catch(() => {});
                await handler({ type: EventTypes.CHAT_INITIALIZED, chat, timestamp: Date.now() });
              }
              if (chat.lastMessage && this.claimMessageId(chat.lastMessage.id)) {
                const events = await this.mapMessageToEvents(chat.lastMessage, chat);
                for (const ev of events) await handler(ev);
              }
            }

            if (data.chatMessageCreated && msg.id) {
              const chatId = this.chatSubIds.get(msg.id);
              const chat = chatId ? this.knownChats.get(chatId) : undefined;
              const chatMsg = mapMessage(data.chatMessageCreated);
              if (chat && this.claimMessageId(chatMsg.id)) {
                const events = await this.mapMessageToEvents(chatMsg, chat);
                for (const ev of events) await handler(ev);
              }
            }
          }
        } catch {
          // keep WS loop resilient
        }
      });

      ws.on('close', () => {
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        if (!this.closed) {
          if (this.wsLostAt === null) {
            this.wsLostAt = this.wsLastRecvAt || Date.now();
          }
          this.wsReconnectAttempts += 1;
          const delayMs = Math.min(3_000 * this.wsReconnectAttempts, 30_000);
          this.reconnectTimer = setTimeout(connectWs, delayMs);
          this.reconnectTimer.unref?.();
        }
      });

      ws.on('error', () => {
        // handled by close
      });
    };

    connectWs();

    this.reviewTimer = setInterval(() => {
      void this.pollPendingReviews(handler);
    }, Math.min(this.reviewPollIntervalMs, 5_000));
    this.reviewTimer.unref?.();

    this.dealsPollTimer = setInterval(() => {
      void this.pollNewDeals(handler);
    }, this.newDealsPollIntervalMs);
    this.dealsPollTimer.unref?.();

    return () => {
      void this.close();
    };
  }

  public async close(): Promise<void> {
    this.closed = true;
    // Drain the throttle queues first: nobody may keep waiting for a slot the
    // closed transport will never use. Pending acquire() calls reject instead
    // of hanging, and no pump timer survives the close.
    this.httpLimiter.close();
    this.wsLimiter.close();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reviewTimer) {
      clearInterval(this.reviewTimer);
      this.reviewTimer = null;
    }
    if (this.dealsPollTimer) {
      clearInterval(this.dealsPollTimer);
      this.dealsPollTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    await this.fetchDispatcher?.close().catch(() => {});
  }
}
