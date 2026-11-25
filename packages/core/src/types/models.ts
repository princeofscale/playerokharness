import type {
  ChatStatuses,
  ChatTypes,
  EventTypes,
  GameCategoryDataFieldTypes,
  ItemDealDirections,
  ItemDealStatuses,
  ItemStatuses,
  PriorityTypes,
  ReviewStatuses,
  TransactionDirections,
  TransactionOperations,
  TransactionProviderIds,
  TransactionStatuses,
  UserTypes,
} from './enums.js';

export interface FileObject {
  id: string;
  url: string;
  filename?: string | null;
  mime?: string | null;
}

export interface AccountBalance {
  id: string;
  value: number;
  frozen: number;
  available: number;
  withdrawable: number;
  pendingIncome: number;
}

export interface DealStatsCounter {
  total: number;
  finished: number;
}

export interface AccountStats {
  items: {
    total: number;
    finished: number;
  };
  deals: {
    incoming: DealStatsCounter;
    outgoing: DealStatsCounter;
  };
}

export interface UserProfile {
  id: string;
  username: string;
  role?: UserTypes | null;
  avatarUrl?: string | null;
  isOnline?: boolean;
  isBlocked?: boolean;
  rating?: number | null;
  reviewsCount?: number | null;
  supportChatId?: string | null;
  systemChatId?: string | null;
  createdAt?: string | null;
}

export interface AccountProfile extends UserProfile {
  balance?: AccountBalance | null;
  stats?: AccountStats | null;
}

export interface AccountInfo {
  id: string;
  username: string;
  email?: string | null;
  role?: string | null;
  supportChatId?: string | null;
  systemChatId?: string | null;
  unreadChatsCounter?: number;
  isBlocked?: boolean;
  isBlockedFor?: string | null;
  createdAt?: string | null;
  hasFrozenBalance?: boolean;
  hasConfirmedPhoneNumber?: boolean;
  canPublishItems?: boolean;
  profile: AccountProfile;
}

export interface GameCategoryRef {
  id: string;
  name?: string;
  slug?: string;
}

export interface ObtainingTypeRef {
  id: string;
  name?: string;
}

export interface DataField {
  id: string;
  label?: string;
  type: GameCategoryDataFieldTypes;
  value: string;
  hidden?: boolean;
}

export interface ItemPriorityStatus {
  id: string;
  price: number;
  name: string;
  type: PriorityTypes;
  period?: number;
}

export interface ItemProfile {
  id: string;
  slug: string;
  priority?: PriorityTypes | null;
  status?: ItemStatuses | null;
  name: string;
  price: number;
  rawPrice: number;
  sellerType?: UserTypes | null;
  attachment?: FileObject | null;
  user?: UserProfile | null;
  approvalDate?: string | null;
  priorityPosition?: number | null;
  viewsCounter?: number | null;
  feeMultiplier?: number | null;
  createdAt?: string | null;
  sequence?: number | null;
}

export interface MyItem extends ItemProfile {
  description?: string | null;
  attributes?: Record<string, unknown>;
  category?: GameCategoryRef | null;
  obtainingType?: ObtainingTypeRef | null;
  attachments?: FileObject[];
  dataFields?: DataField[];
  mayBePublished?: boolean;
}

export interface Review {
  id: string;
  status?: ReviewStatuses | null;
  text?: string | null;
  rating: number;
  createdAt: string;
  creator: UserProfile;
  user?: UserProfile | null;
  dealId?: string | null;
}

export interface ItemDeal {
  id: string;
  status: ItemDealStatuses;
  direction?: ItemDealDirections;
  user: UserProfile;
  item: ItemProfile | MyItem;
  chatId?: string | null;
  review?: Review | null;
  createdAt?: string | null;
  completedAt?: string | null;
  hasProblem?: boolean;
  commentFromBuyer?: string | null;
}

export interface ChatMessage {
  id: string;
  text: string | null;
  createdAt: string;
  isRead?: boolean;
  user: UserProfile;
  images?: FileObject[];
  deal?: ItemDeal | null;
}

export interface Chat {
  id: string;
  type: ChatTypes;
  status?: ChatStatuses | null;
  unreadMessagesCounter?: number;
  users: UserProfile[];
  lastMessage?: ChatMessage | null;
  deals?: ItemDeal[];
}

export interface Transaction {
  id: string;
  operation: TransactionOperations;
  direction: TransactionDirections;
  providerId?: TransactionProviderIds | null;
  status: TransactionStatuses;
  value: number;
  fee?: number;
  createdAt: string;
  account?: string | null;
}

export interface PageInfo {
  startCursor?: string | null;
  endCursor?: string | null;
  hasPreviousPage?: boolean;
  hasNextPage: boolean;
}

export interface PaginatedList<T> {
  items: T[];
  pageInfo: PageInfo;
  totalCount?: number;
}

// PlayerOK event payloads
export interface BasePlayerokEvent {
  type: EventTypes;
  chat: Chat;
  timestamp: number;
}

export interface ChatInitializedEvent extends BasePlayerokEvent {
  type: EventTypes.CHAT_INITIALIZED;
}

export interface NewMessageEvent extends BasePlayerokEvent {
  type: EventTypes.NEW_MESSAGE;
  message: ChatMessage;
}

export interface DealEvent extends BasePlayerokEvent {
  type:
    | EventTypes.NEW_DEAL
    | EventTypes.NEW_REVIEW
    | EventTypes.DEAL_CONFIRMED
    | EventTypes.DEAL_CONFIRMED_AUTOMATICALLY
    | EventTypes.DEAL_ROLLED_BACK
    | EventTypes.DEAL_HAS_PROBLEM
    | EventTypes.DEAL_PROBLEM_RESOLVED
    | EventTypes.DEAL_STATUS_CHANGED
    | EventTypes.ITEM_PAID
    | EventTypes.ITEM_SENT;
  deal: ItemDeal;
}

export type PlayerokEvent = ChatInitializedEvent | NewMessageEvent | DealEvent;

// Notification & UI types
export interface InlineButton {
  text: string;
  callbackData?: string;
  url?: string;
}

export interface NotificationPayload {
  title: string;
  body?: string;
  buttons?: InlineButton[][];
  eventKey?: string;
}

export interface SellerCallPayload {
  username: string;
  chatId: string;
}

// External plugin metadata
export interface ExternalPluginMeta {
  id: string;
  name: string;
  version: string;
  description?: string;
  authors?: string;
  links?: string;
  prefix?: string;
}

export interface LoadedPluginRecord {
  id: string;
  meta: ExternalPluginMeta;
  enabled: boolean;
  sourcePath: string;
  error?: string;
}

export interface SbpBankMember {
  id: string;
  name: string;
  icon?: string | null;
}

export interface VerifiedCard {
  id: string;
  cardFirstSix: string;
  cardLastFour: string;
  cardType?: string | null;
  isChosen?: boolean;
}

export interface SetupProblem {
  code: 'missing_cookies' | 'unauthorized' | 'bot_check' | 'blocked' | 'network' | 'unknown';
  text: string;
  transient: boolean;
}

export interface BootError {
  module: string;
  stage: 'load' | 'start' | 'disabled' | 'recover';
  text: string;
  trace: string;
}

export interface GitHubRelease {
  tagName: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string;
  zipballUrl?: string;
}

export interface PluginCheckResult {
  id: string;
  status: 'ok' | 'error' | 'timeout';
  trace?: string;
  hasBackup: boolean;
}

/**
 * One pinned plugin file in bot_data/plugin_integrity.json. Written by
 * installPluginFile() and, for plugins already on disk, by the first discovery.
 */
export interface PluginIntegrityEntry {
  sha256: string;
  size: number;
  /** ISO timestamp of the install/discovery that pinned this hash. */
  installedAt: string;
  /** Absolute path the hash was taken from. */
  file: string;
}

/**
 * ok      — hash on disk equals the pinned hash
 * mismatch— pinned hash differs (file was modified outside the manager)
 * unknown — a plugin file exists but no hash was ever pinned for it
 * missing — a hash is pinned but the file is gone
 */
export type PluginIntegrityState = 'ok' | 'mismatch' | 'missing' | 'unknown';

export interface PluginIntegrityResult {
  id: string;
  /** Pinned sha256, or null when the plugin was never recorded. */
  expected: string | null;
  /** sha256 of the file currently on disk, or null when it cannot be read. */
  actual: string | null;
  /** True only for an exact match; a mismatch, unknown or missing file is never ok. */
  ok: boolean;
  state: PluginIntegrityState;
  path?: string;
  size?: number;
  installedAt?: string;
}

// ---------------------------------------------------------------------------
// Audit trail (bot_data/audit.jsonl, one JSON object per line)
// ---------------------------------------------------------------------------

/** Who caused the automated money/inventory action. */
export type AuditActor = 'auto' | 'telegram' | 'system';

/** Did the action happen, fail, or was it deliberately not attempted. */
export type AuditOutcome = 'ok' | 'failed' | 'skipped';

/**
 * One line of bot_data/audit.jsonl. Append-only: a record is never rewritten,
 * so the file stays a linear history of what the bot did with money and stock.
 */
export interface AuditEntry {
  /** ISO timestamp (UTC) of the action. */
  at: string;
  /** Dotted action name, e.g. `delivery.sent` or `withdrawal.requested`. */
  action: string;
  actor: AuditActor;
  outcome: AuditOutcome;
  /** One-line human summary. Never a token, cookie or delivered goods value. */
  title: string;
  /** Small structured context (ids, amounts, counts) — no credentials. */
  details?: Record<string, unknown>;
}

/**
 * Input of AuditService.record(). `at` defaults to now, `actor` to 'auto',
 * `outcome` to 'ok'; a caller that knows none of them only has to name the action.
 */
export interface AuditRecordInput {
  action: string;
  title: string;
  actor?: AuditActor;
  outcome?: AuditOutcome;
  details?: Record<string, unknown>;
  at?: string;
}

/**
 * Query of AuditService.list(). `since` is inclusive and accepts an ISO
 * timestamp or epoch milliseconds; results are newest-first.
 */
export interface AuditListOptions {
  limit?: number;
  since?: string | number;
  action?: string;
}

export interface AuditStats {
  entries: number;
  /** Alias of `entries`, kept for dashboards that look for `total`. */
  total: number;
  bytes: number;
  /** Newest-first counters, so a dashboard can show what the trail is made of. */
  byAction: Array<{ key: string; count: number }>;
  byOutcome: Array<{ key: string; count: number }>;
  oldestAt?: string;
  newestAt?: string;
}

/** Retention bounds of prune(); every field falls back to the service default. */
export interface AuditPruneOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxAgeDays?: number;
}

export interface AuditPruneResult {
  /** Lines dropped from the file (old, malformed, over the entry cap or the byte cap). */
  removed: number;
  /** Lines left in the file, newest kept. */
  kept: number;
  /** Size of the rewritten file in bytes. */
  bytes: number;
}
