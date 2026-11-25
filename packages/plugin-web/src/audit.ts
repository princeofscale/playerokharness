/**
 * Structural reader for the optional audit service.
 *
 * The audit trail is provided by an optional service that this package must not
 * depend on at compile time (same pattern as `retryQueue` and `logSink`), so
 * everything here is duck-typed: any object that can list records and,
 * optionally, report counters is accepted. Reading never throws — a missing,
 * half-initialised or broken service degrades to an explanation on the page.
 *
 * Nothing here is HTML: this module only normalises data, `render.ts` owns markup.
 */

/** One audit record as the dashboard shows it. */
export interface AuditEntryView {
  /** Source id when the service provides one, used only for stable ordering hints. */
  id: string | null;
  /** Timestamp as the source wrote it (ISO preferred); empty when absent. */
  at: string;
  action: string;
  outcome: string;
  /** Human-readable subject of the record: deal, item, user. */
  title: string;
}

/** One aggregate bucket of `stats()`, e.g. action "deal.deliver" -> 12. */
export interface AuditBucket {
  key: string;
  count: number;
}

/** Counters reported by the optional `stats()` method. */
export interface AuditStatsView {
  total: number | null;
  byAction: AuditBucket[];
  byOutcome: AuditBucket[];
}

/** Everything the audit page and /api/audit need. */
export interface AuditView {
  /** False when no audit service is mounted at all. */
  available: boolean;
  /** Non-null when the service exists but could not be read. */
  error: string | null;
  entries: AuditEntryView[];
  /** Records matching the filter, before the page limit is applied. */
  total: number;
  limit: number;
  action: string | null;
  /** Distinct actions seen in the scanned window, for the filter hint. */
  actions: string[];
  stats: AuditStatsView | null;
}

/** Everything that can list records; every member is probed at runtime. */
export interface AuditSourceLike {
  list?: (...args: unknown[]) => unknown;
  query?: (...args: unknown[]) => unknown;
  stats?: (...args: unknown[]) => unknown;
}

export interface AuditReadOptions {
  limit?: number;
  action?: string | null;
}

/** Hard cap on rows per page, whatever `?limit=` asks for. */
export const MAX_AUDIT_ROWS = 200;
/** Rows shown when the request names no limit. */
export const DEFAULT_AUDIT_ROWS = 50;
/**
 * How many raw records are requested so filtering and ordering happen on a full
 * window instead of on whatever the page would have shown.
 */
export const MAX_AUDIT_SCAN = 500;

/** Field aliases, so the page survives a differently named audit record shape. */
const TIME_KEYS = ['at', 'time', 'timestamp', 'ts', 'createdAt', 'created_at', 'date', 'when'];
const ACTION_KEYS = ['action', 'type', 'kind', 'event', 'name'];
const OUTCOME_KEYS = ['outcome', 'status', 'result', 'state'];
const TITLE_KEYS = ['title', 'message', 'summary', 'text', 'description', 'details'];
const ID_KEYS = ['id', 'key', 'uid'];
const ROWS_KEYS = ['entries', 'items', 'records', 'events', 'rows', 'list'];

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

/** Non-negative integer from a counter field, or null when it is not a count. */
function pickCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function pickTime(record: Record<string, unknown>): string {
  for (const key of TIME_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Epoch milliseconds are the common numeric encoding; ISO keeps the table
      // readable and sorts the same way. An out-of-range value is simply dropped.
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return '';
}

function pickOutcome(record: Record<string, unknown>): string {
  const direct = pickString(record, OUTCOME_KEYS);
  if (direct !== null) return direct;
  if (typeof record.ok === 'boolean') return record.ok ? 'ok' : 'fail';
  if (typeof record.success === 'boolean') return record.success ? 'ok' : 'fail';
  return 'unknown';
}

/** Accepts a bare array or an envelope such as `{ entries: [...] }`. */
function extractRows(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return null;
  for (const key of ROWS_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

/** Normalises whatever the service returned into view rows. Never throws. */
export function normalizeAuditEntries(payload: unknown): AuditEntryView[] {
  const rows = extractRows(payload);
  if (rows === null) return [];

  const entries: AuditEntryView[] = [];
  for (const row of rows) {
    // A plain string in the list is still a usable record ("что случилось").
    if (typeof row === 'string') {
      entries.push({ id: null, at: '', action: 'unknown', outcome: 'unknown', title: row });
      continue;
    }
    const record = asRecord(row);
    if (!record) continue;
    entries.push({
      id: pickString(record, ID_KEYS),
      at: pickTime(record),
      action: pickString(record, ACTION_KEYS) ?? 'unknown',
      outcome: pickOutcome(record),
      title: pickString(record, TITLE_KEYS) ?? '',
    });
  }
  return entries;
}

/**
 * Newest first. Records whose timestamp cannot be parsed keep their source
 * order: a stateless reader has no better ordering information than that.
 */
export function sortAuditNewestFirst(entries: readonly AuditEntryView[]): AuditEntryView[] {
  return entries
    .map((entry, index) => ({ entry, index, at: Date.parse(entry.at) }))
    .sort((left, right) => {
      const leftKnown = Number.isFinite(left.at);
      const rightKnown = Number.isFinite(right.at);
      if (leftKnown && rightKnown && left.at !== right.at) return right.at - left.at;
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      return left.index - right.index;
    })
    .map((item) => item.entry);
}

/** `?limit=`: positive integer, clamped to {@link MAX_AUDIT_ROWS}. */
export function normalizeAuditLimit(raw: string | number | null | undefined): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_AUDIT_ROWS;
  return Math.min(parsed, MAX_AUDIT_ROWS);
}

/** `?action=`: trimmed, bounded, empty means "no filter". */
export function normalizeAuditAction(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 200);
}

function normalizeBuckets(value: unknown): AuditBucket[] {
  if (Array.isArray(value)) {
    const buckets: AuditBucket[] = [];
    for (const item of value) {
      const record = asRecord(item);
      if (!record) continue;
      const key = pickString(record, ['key', 'name', 'action', 'outcome']);
      const count = pickCount(record.count ?? record.total ?? record.value);
      if (key !== null && count !== null) buckets.push({ key, count });
    }
    return buckets.sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
  }

  const record = asRecord(value);
  if (!record) return [];
  const buckets: AuditBucket[] = [];
  for (const [key, raw] of Object.entries(record)) {
    const count = pickCount(raw);
    if (count !== null) buckets.push({ key, count });
  }
  return buckets.sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

/** Normalises `stats()`; null when the payload carries no counter at all. */
export function normalizeAuditStats(payload: unknown): AuditStatsView | null {
  const record = asRecord(payload);
  if (!record) return null;

  const total = pickCount(record.total ?? record.count ?? record.all);
  const byAction = normalizeBuckets(record.byAction ?? record.actions);
  const byOutcome = normalizeBuckets(record.byOutcome ?? record.outcomes);
  if (total === null && byAction.length === 0 && byOutcome.length === 0) return null;
  return { total, byAction, byOutcome };
}

/** An empty view; also the shape returned when the service is missing or broken. */
export function emptyAuditView(options: {
  available: boolean;
  limit?: number;
  action?: string | null;
  error?: string | null;
}): AuditView {
  return {
    available: options.available,
    error: options.error ?? null,
    entries: [],
    total: 0,
    limit: normalizeAuditLimit(options.limit),
    action: normalizeAuditAction(options.action),
    actions: [],
    stats: null,
  };
}

/** Counters are decoration: a failure here must never hide the entries. */
export function readAuditStats(source: AuditSourceLike | null | undefined): AuditStatsView | null {
  if (!source || typeof source.stats !== 'function') return null;
  try {
    return normalizeAuditStats(source.stats.call(source));
  } catch {
    return null;
  }
}

/**
 * Calls `list()` (or `query()`) and returns the raw payload. A method that
 * declares a parameter gets the scan window; one that does not is called bare.
 * Reading is side-effect free, so retrying with no argument after a rejected
 * options object is safe and can rescue a service with a different signature.
 */
function listAuditRecords(source: AuditSourceLike, action: string | null): unknown {
  const list = typeof source.list === 'function' ? source.list : source.query;
  if (typeof list !== 'function') {
    throw new TypeError('Служба аудита не предоставляет list()');
  }
  if (list.length >= 1) {
    try {
      return list.call(source, { limit: MAX_AUDIT_SCAN, ...(action === null ? {} : { action }) });
    } catch {
      // fall through to the bare call below
    }
  }
  return list.call(source);
}

/**
 * Reads the audit trail through any structurally compatible service.
 *
 * @param source  `ctx.get('audit', false)` or null when the service is absent
 * @param options page limit and action filter, both already parsed from the URL
 */
export function readAudit(
  source: AuditSourceLike | null | undefined,
  options: AuditReadOptions = {},
): AuditView {
  const limit = normalizeAuditLimit(options.limit);
  const action = normalizeAuditAction(options.action);

  if (!source) return emptyAuditView({ available: false, limit, action });

  let payload: unknown;
  try {
    payload = listAuditRecords(source, action);
  } catch (error) {
    return emptyAuditView({ available: true, limit, action, error: describeError(error) });
  }

  const scanned = sortAuditNewestFirst(normalizeAuditEntries(payload));
  const actions = [...new Set(scanned.map((entry) => entry.action))].sort((left, right) =>
    left.localeCompare(right),
  );
  // Filtering locally as well as asking the service means a service that ignores
  // the options object still produces a correct page.
  const matching =
    action === null
      ? scanned
      : scanned.filter((entry) => entry.action.toLowerCase() === action.toLowerCase());

  return {
    available: true,
    error: null,
    entries: matching.slice(0, limit),
    total: matching.length,
    limit,
    action,
    actions,
    stats: readAuditStats(source),
  };
}
