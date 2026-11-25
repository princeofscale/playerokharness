import type { PluginIntegrityResult } from '@pkh/core';

/**
 * System panel — the operator screens that must work from Telegram alone.
 *
 * Everything here is a structural, side-effect-free reader, for the same reason the web
 * dashboard duck-types its inputs: the audit trail is an optional service (the panel must
 * not depend on it at compile time), the retry queue may be unmounted, and an older
 * plugin manager may lack the integrity check. Each reader returns null instead of
 * throwing, so a screen can explain the gap. Markup lives in keyboards.ts; service.ts
 * wires these readers to ctx.
 */

// ---------------------------------------------------------------------------
// Audit trail (optional service — probed by name, never imported)
// ---------------------------------------------------------------------------

/** Records per page on the Telegram audit screen. */
export const AUDIT_PAGE_SIZE = 10;

/** Outcome bucket the panel renders with an icon. */
export type AuditOutcomeKind = 'ok' | 'failed' | 'skipped' | 'unknown';

/** One audit record as the panel shows it. */
export interface AuditEntryView {
  /** Parsed ISO timestamp; empty when the record carries no usable time. */
  at: string;
  /** Dotted action name, e.g. `delivery.sent`. */
  action: string;
  outcome: AuditOutcomeKind;
  /** One-line human summary (already unescaped). */
  title: string;
  /** Who caused the action, when the record says so. */
  actor: string | null;
}

/** Every member an audit service may expose; each is probed at runtime. */
export interface AuditLogLike {
  list?: (...args: unknown[]) => unknown;
  query?: (...args: unknown[]) => unknown;
  stats?: (...args: unknown[]) => unknown;
  clear?: (...args: unknown[]) => unknown;
  prune?: (...args: unknown[]) => unknown;
}

/** One page of the audit trail, already ordered newest-first. */
export interface AuditPage {
  entries: AuditEntryView[];
  page: number;
  hasMore: boolean;
  /** Record count when the fetched window proves it; null when the log is longer. */
  total: number | null;
}

/** Field aliases, so the screen survives a differently named audit record shape. */
const TIME_KEYS = ['at', 'time', 'timestamp', 'ts', 'createdAt', 'created_at', 'date', 'when'] as const;
const ACTION_KEYS = ['action', 'type', 'kind', 'event', 'name'] as const;
const OUTCOME_KEYS = ['outcome', 'status', 'result', 'state'] as const;
const TITLE_KEYS = ['title', 'message', 'summary', 'text', 'description'] as const;
const ACTOR_KEYS = ['actor', 'by', 'user', 'source'] as const;
const ROWS_KEYS = ['entries', 'items', 'records', 'events', 'rows', 'list'] as const;
const STATS_TOTAL_KEYS = ['total', 'count', 'entries', 'all', 'records'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
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
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return '';
}

function classifyOutcome(raw: string | null): AuditOutcomeKind {
  if (raw === null) return 'unknown';
  const value = raw.trim().toLowerCase();
  if (/fail|error|denied|refused|reject|cancel/.test(value)) return 'failed';
  if (/skip|ignor|noop|no-op|dry/.test(value)) return 'skipped';
  if (/ok|success|allow|grant|applied|done|sent|created|complete/.test(value)) return 'ok';
  return 'unknown';
}

function pickOutcome(record: Record<string, unknown>): AuditOutcomeKind {
  if (typeof record.ok === 'boolean') return record.ok ? 'ok' : 'failed';
  if (typeof record.success === 'boolean') return record.success ? 'ok' : 'failed';
  return classifyOutcome(pickString(record, OUTCOME_KEYS));
}

/** Accepts a bare array or an envelope such as `{ entries: [...] }`. */
function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of ROWS_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** Normalises whatever the service returned into view rows. Never throws. */
export function normalizeAuditEntries(payload: unknown): AuditEntryView[] {
  const entries: AuditEntryView[] = [];
  for (const row of extractRows(payload)) {
    // A plain string in the list is still a usable record ("что случилось").
    if (typeof row === 'string') {
      entries.push({ at: '', action: 'unknown', outcome: 'unknown', title: row, actor: null });
      continue;
    }
    const record = asRecord(row);
    if (!record) continue;
    entries.push({
      at: pickTime(record),
      action: pickString(record, ACTION_KEYS) ?? 'unknown',
      outcome: pickOutcome(record),
      title: pickString(record, TITLE_KEYS) ?? '',
      actor: pickString(record, ACTOR_KEYS),
    });
  }
  return entries;
}

/**
 * Newest first. Records whose timestamp cannot be parsed keep their source order:
 * the reader has no better ordering information than that.
 */
function sortNewestFirst(entries: readonly AuditEntryView[]): AuditEntryView[] {
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

/**
 * Hard cap on a requested page. callback_data is user-supplied, so an absurd page number
 * must not turn into an unbounded `list({ limit })` that reads the whole log.
 */
export const AUDIT_MAX_PAGE = 200;

/** Page number clamped to a non-negative integer inside {@link AUDIT_MAX_PAGE}. */
export function clampAuditPage(page: number): number {
  if (!Number.isFinite(page) || page <= 0) return 0;
  return Math.min(Math.trunc(page), AUDIT_MAX_PAGE);
}

/**
 * How many records to request for one page: everything up to the end of the page plus
 * one more, which proves whether a next page exists without needing a total.
 */
export function auditPageLimit(page: number): number {
  return (clampAuditPage(page) + 1) * AUDIT_PAGE_SIZE + 1;
}

/** One page out of a `list({ limit })` payload. Never throws. */
export function buildAuditPage(payload: unknown, page: number): AuditPage {
  const safePage = clampAuditPage(page);
  const ordered = sortNewestFirst(normalizeAuditEntries(payload));
  const start = safePage * AUDIT_PAGE_SIZE;
  const end = start + AUDIT_PAGE_SIZE;
  const hasMore = ordered.length > end;
  return {
    entries: ordered.slice(start, end),
    page: safePage,
    hasMore,
    // The window always starts at the newest record, so a short window is the whole log.
    total: hasMore ? null : ordered.length,
  };
}

/** Total record count out of a `stats()` payload, or null when it carries none. */
export function auditTotalOf(stats: unknown): number | null {
  const direct = pickCount(stats);
  if (direct !== null) return direct;
  const record = asRecord(stats);
  if (!record) return null;
  for (const key of STATS_TOTAL_KEYS) {
    const count = pickCount(record[key]);
    if (count !== null) return count;
  }
  return null;
}

/** Compact timestamp for one audit line: `YYYY-MM-DD HH:MM:SS` when parseable. */
export function auditTimestampText(at: string): string {
  const trimmed = at.trim();
  if (!trimmed) return '—';
  const iso = trimmed.replace('T', ' ').replace(/\.\d+/, '').replace(/Z$/, '');
  return iso.length > 19 ? iso.slice(0, 19) : iso;
}

// ---------------------------------------------------------------------------
// Runtime health (process counters + optional retry queue)
// ---------------------------------------------------------------------------

/** Queue composition as the health screen shows it. */
export interface RetryQueueHealth {
  pending: number;
  dead: number;
  processing: number;
}

/** Structural view of @pkh/plugin-retry-queue; the service may be unmounted. */
export interface RetryQueueLike {
  getStats?: (...args: unknown[]) => unknown;
}

/** Everything the runtime-health screen renders. */
export interface RuntimeHealthSnapshot {
  uptimeSec: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  nodeVersion: string;
  platform: string;
  pid: number;
  pluginsEnabled: number;
  pluginsTotal: number;
  /** null when the retry queue is not mounted or reports nothing usable. */
  retryQueue: RetryQueueHealth | null;
}

/** Normalises a `getStats(true)` payload; null when it carries no counters at all. */
export function retryQueueHealth(stats: unknown): RetryQueueHealth | null {
  const record = asRecord(stats);
  if (!record) return null;
  const pending = pickCount(record.pending);
  const dead = pickCount(record.dead);
  const processing = pickCount(record.processing);
  if (pending === null && dead === null && processing === null) return null;
  return { pending: pending ?? 0, dead: dead ?? 0, processing: processing ?? 0 };
}

/** Human uptime: `2д 3ч 4м` / `3ч 4м 5с` / `4м 5с` / `5с`. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (days > 0) return days + 'д ' + hours + 'ч ' + minutes + 'м';
  if (hours > 0) return hours + 'ч ' + minutes + 'м ' + rest + 'с';
  if (minutes > 0) return minutes + 'м ' + rest + 'с';
  return rest + 'с';
}

/** Bytes as `512 Б` / `120.4 МБ` (one decimal until the value is large). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Bytes are integers; everything above keeps one decimal (120.5 МБ, 45.0 МБ).
  const digits = unit === 0 ? 0 : 1;
  return value.toFixed(digits) + ' ' + units[unit];
}

// ---------------------------------------------------------------------------
// Plugin integrity
// ---------------------------------------------------------------------------

/**
 * Structural view of PluginManagerService. The check is probed at runtime because an
 * older manager (or a host that mounts a different one) has no such method.
 */
export interface PluginIntegrityManagerLike {
  verifyPluginIntegrity?: () => PluginIntegrityResult[];
}

/** Runs the optional integrity check; null when the manager cannot verify. */
export function readPluginIntegrity(
  manager: PluginIntegrityManagerLike | null | undefined,
): PluginIntegrityResult[] | null {
  if (!manager || typeof manager.verifyPluginIntegrity !== 'function') return null;
  const results = manager.verifyPluginIntegrity();
  return Array.isArray(results) ? results : [];
}

/** Short sha256 prefix for a screen that must stay readable: 10 hex chars. */
export function integrityHashPrefix(hash: string | null | undefined): string {
  return typeof hash === 'string' && hash.length > 0 ? hash.slice(0, 10) : '—';
}

/** One-line description of a thrown value, for logs and operator-facing explanations. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
