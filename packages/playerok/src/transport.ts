import type { ContractIssue } from './schemas.js';
import type { TokenBucketStats } from './rate-limit.js';
import type {
  AccountInfo,
  Chat,
  ChatMessage,
  DataField,
  ItemDeal,
  ItemDealDirections,
  ItemDealStatuses,
  ItemPriorityStatus,
  ItemStatuses,
  MyItem,
  PaginatedList,
  PlayerokEvent,
  Review,
  SbpBankMember,
  Transaction,
  TransactionProviderIds,
  UserProfile,
  VerifiedCard,
} from '@pkh/core';

export interface BinaryUpload {
  filename: string;
  data: Buffer;
  contentType?: string;
}

export interface SendMessageParams {
  chatId: string;
  text?: string | null;
  images?: BinaryUpload[];
  markChatAsRead?: boolean;
}

export interface GetMyItemsParams {
  afterCursor?: string | null;
  statuses?: ItemStatuses[];
  gameId?: string | null;
  categoryId?: string | null;
  obtainingTypeId?: string | null;
  count?: number;
}

export interface CreateItemParams {
  gameCategoryId: string;
  obtainingTypeId: string;
  name: string;
  price: number;
  description: string;
  options?: Record<string, unknown>;
  dataFields?: DataField[];
  attachments?: BinaryUpload[];
}

export interface UpdateItemParams {
  name?: string;
  price?: number;
  description?: string;
  dataFields?: DataField[];
}

export interface GetDealsParams {
  afterCursor?: string | null;
  statuses?: ItemDealStatuses[];
  direction?: ItemDealDirections;
  count?: number;
}

export interface GetReviewsParams {
  count?: number;
  afterCursor?: string | null;
  rating?: number | null;
  commentRequired?: boolean;
}

export interface RequestWithdrawalParams {
  provider: TransactionProviderIds;
  account: string;
  value: number;
  sbpBankMemberId?: string | null;
}

export type PlayerokEventHandler = (event: PlayerokEvent) => void | Promise<void>;

/** Failure classes tracked for outbound PlayerOK traffic. */
export type RequestFailureClass = 'unauthorized' | 'bot-check' | 'network' | 'graphql';

export interface RequestLatencyStats {
  /** Summed latency of tracked requests (ms). */
  totalMs: number;
  /** Number of tracked requests that contributed to `totalMs`. */
  count: number;
  /** `totalMs / count`, or 0 before the first request. */
  averageMs: number;
}

/**
 * Outbound observability snapshot: how much traffic the transport issues, where
 * it fails, how slow PlayerOK answers and how saturated the throttles are.
 */
export interface RequestStats {
  /** Completed outbound calls per operation (`viewer`, `deals`, `ws:subscribe`, ...). */
  requests: Record<string, number>;
  /** Failures per class; a failure is always also counted in `requests`. */
  failures: Record<RequestFailureClass, number>;
  /** Sum of `requests`. */
  totalRequests: number;
  latency: RequestLatencyStats;
  /** Live throttle state: HTTP bucket and the separate WS-send bucket. */
  limiters: { http: TokenBucketStats; ws: TokenBucketStats };
}

/** Zeroed limiter snapshot (an unlimited bucket, or the mock transport). */
export function emptyTokenBucketStats(): TokenBucketStats {
  return { available: 0, queued: 0, acquired: 0, rejected: 0 };
}

/** Zeroed `RequestStats`: what a transport without instrumentation reports. */
export function emptyRequestStats(): RequestStats {
  return {
    requests: {},
    failures: { unauthorized: 0, 'bot-check': 0, network: 0, graphql: 0 },
    totalRequests: 0,
    latency: { totalMs: 0, count: 0, averageMs: 0 },
    limiters: { http: emptyTokenBucketStats(), ws: emptyTokenBucketStats() },
  };
}

export interface PlayerokTransport {
  readonly kind: 'mock' | 'graphql' | string;

  getAccount(): Promise<AccountInfo>;
  getUser(userId: string): Promise<UserProfile>;

  getChats(count?: number, afterCursor?: string | null): Promise<PaginatedList<Chat>>;
  getChat(chatId: string): Promise<Chat>;
  getChatMessages(chatId: string, count?: number): Promise<ChatMessage[]>;
  markChatAsRead(chatId: string): Promise<void>;
  sendMessage(params: SendMessageParams): Promise<ChatMessage>;
  downloadFile(url: string): Promise<Buffer>;

  getMyItems(params?: GetMyItemsParams): Promise<PaginatedList<MyItem>>;
  getItem(ref: { id?: string; slug?: string }): Promise<MyItem>;
  getItemPriorityStatuses(itemId: string, rawPrice: number): Promise<ItemPriorityStatus[]>;
  increaseItemPriorityStatus(itemId: string, priorityStatusId: string): Promise<MyItem>;
  publishItem(itemId: string, priorityStatusId: string): Promise<MyItem>;
  createItem(params: CreateItemParams): Promise<MyItem>;
  updateItem(itemId: string, params: UpdateItemParams): Promise<MyItem>;
  removeItem(itemId: string): Promise<boolean>;

  getDeals(params?: GetDealsParams): Promise<PaginatedList<ItemDeal>>;
  getDeal(dealId: string): Promise<ItemDeal>;
  updateDeal(dealId: string, status: ItemDealStatuses): Promise<ItemDeal>;
  reportDealProblem(dealId: string, description: string, problemTypeId: string): Promise<ItemDeal>;

  getReviews(params?: GetReviewsParams): Promise<PaginatedList<Review>>;
  getTransactions(count?: number, afterCursor?: string | null): Promise<PaginatedList<Transaction>>;
  getSbpBankMembers(): Promise<SbpBankMember[]>;
  getVerifiedCards(): Promise<VerifiedCard[]>;
  requestWithdrawal(params: RequestWithdrawalParams): Promise<Transaction>;
  removeTransaction(transactionId: string): Promise<Transaction>;

  subscribe(handler: PlayerokEventHandler): Promise<() => void>;
  close(): Promise<void>;

  /**
   * Optional response-contract diagnostics: transports that validate raw GraphQL/WS
   * payloads report recent field drift here. A transport without validation
   * (e.g. `MockPlayerokTransport`) simply does not implement it.
   */
  getContractIssues?(): ContractIssue[];

  /**
   * Optional outbound observability: request/failure/latency counters and the
   * current throttle state. A transport that does not throttle (the mock)
   * either omits it or reports `emptyRequestStats()`.
   */
  getRequestStats?(): RequestStats;
}
