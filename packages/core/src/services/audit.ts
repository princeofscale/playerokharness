import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Context, Service } from 'cordis';
import type {
  AuditActor,
  AuditEntry,
  AuditListOptions,
  AuditOutcome,
  AuditPruneOptions,
  AuditPruneResult,
  AuditRecordInput,
  AuditStats,
} from '../types/models.js';
import { redactSecrets } from './log-sink.js';
import type { StorageService } from './storage.js';

/** Live log, resolved through the storage data dir (bot_data/audit.jsonl). */
export const AUDIT_RELATIVE_PATH = 'bot_data/audit.jsonl';

/** Rotation threshold: the previous file becomes audit.jsonl.1 (exactly one archive). */
export const AUDIT_MAX_BYTES = 2 * 1024 * 1024;

/** Defaults of prune(): entry cap, byte cap, age cap. */
export const AUDIT_MAX_ENTRIES = 5000;
export const AUDIT_MAX_AGE_DAYS = 90;

const ACTORS: readonly AuditActor[] = ['auto', 'telegram', 'system'];
const OUTCOMES: readonly AuditOutcome[] = ['ok', 'failed', 'skipped'];

/**
 * A details key that IS a credential gets a placeholder instead of its value:
 * the caller may hand over a whole config slice without meaning to.
 */
const SECRET_KEY_RE =
  /^(?:token|bot_?token|api_?key|cookies?|cookie_?header|set-?cookie|authorization|password|passwd|secret|session|session_?id)$/i;

/** "Cookie: a=b; c=d" is a credential header, not a title: replace it wholesale. */
const COOKIE_HEADER_RE = /\bcookie\b[^\n]{0,24}[:=]/i;

/** details are meant to stay small: bounded depth, key count and string length. */
const DETAILS_MAX_DEPTH = 3;
const DETAILS_MAX_KEYS = 32;
const DETAILS_MAX_STRING = 240;

const DEFAULT_LIST_LIMIT = 100;
/** The smallest tail window list() reads before deciding it needs more. */
const MIN_TAIL_WINDOW = 8 * 1024;

export interface AuditConfig {
  /** Rotation threshold in bytes; defaults to AUDIT_MAX_BYTES (2 MB). */
  maxBytes?: number;
  /** Log location relative to the storage data dir; defaults to bot_data/audit.jsonl. */
  relativePath?: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shorten(value: string): string {
  return value.length > DETAILS_MAX_STRING ? value.slice(0, DETAILS_MAX_STRING) + '…' : value;
}

/**
 * Redacts one user-visible string. A whole cookie header is replaced; everything else
 * runs through the same Telegram-token / Bearer / cookie-pair rules the log sink uses,
 * so a token pasted into an error message never lands in the trail.
 */
function redactText(value: string): string {
  if (COOKIE_HEADER_RE.test(value)) return '[REDACTED_COOKIE]';
  return redactSecrets(shorten(value));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redactText(value.message);

  if (Array.isArray(value)) {
    if (depth >= DETAILS_MAX_DEPTH) return '[' + String(value.length) + ' items]';
    return value.slice(0, DETAILS_MAX_KEYS).map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    if (depth >= DETAILS_MAX_DEPTH) return '[object]';
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).slice(0, DETAILS_MAX_KEYS)) {
      if (SECRET_KEY_RE.test(key)) {
        result[key] = '[REDACTED]';
        continue;
      }
      const sanitized = sanitizeValue(source[key], depth + 1);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  }

  return undefined;
}

function sanitizeDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const safe = sanitizeValue(details, 0);
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) return undefined;
  const result = safe as Record<string, unknown>;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Parses one JSON Lines record; a torn line left by a crash is skipped, not fatal. */
function parseLine(line: string): AuditEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  const at = typeof candidate.at === 'string' ? candidate.at : '';
  const action = typeof candidate.action === 'string' ? candidate.action : '';
  if (!at || !action) return null;

  const entry: AuditEntry = {
    at,
    action,
    actor: candidate.actor === 'telegram' || candidate.actor === 'system' ? candidate.actor : 'auto',
    outcome: candidate.outcome === 'failed' || candidate.outcome === 'skipped' ? candidate.outcome : 'ok',
    title: typeof candidate.title === 'string' ? candidate.title : '',
  };
  if (candidate.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details)) {
    entry.details = candidate.details as Record<string, unknown>;
  }
  return entry;
}

/** ISO timestamp or epoch milliseconds to epoch milliseconds; undefined when unusable. */
function toTimestampMs(value?: string | number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/**
 * Append-only audit trail of every automated money/inventory action.
 *
 * The log is its own JSON Lines file, not a storage store: a store is parsed and
 * rewritten as a whole on every write, while this file must only ever grow by one
 * line at the end. Append + fsync per record means a crash costs at most the line
 * being written, and the reader only ever touches the file tail.
 *
 * record() never throws into the caller: an audit write must not fail a delivery,
 * a bump or a refund that already happened.
 */
export class AuditService extends Service {
  static provide = 'audit';
  static inject = ['storage'];

  /** Absolute path of the live JSON Lines log. */
  public readonly filePath: string;
  /** Keep exactly one archive: the previous file at audit.jsonl.1. */
  public readonly archivePath: string;
  /** Rotation threshold in bytes. */
  public readonly maxBytes: number;

  private readonly log;

  constructor(ctx: Context, config: AuditConfig = {}) {
    super(ctx, 'audit');
    this.log = ctx.logger('audit');
    const storage = ctx.storage as StorageService;
    this.filePath = storage.resolvePath(config.relativePath ?? AUDIT_RELATIVE_PATH);
    this.archivePath = this.filePath + '.1';
    this.maxBytes =
      config.maxBytes !== undefined && config.maxBytes > 0 ? config.maxBytes : AUDIT_MAX_BYTES;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch {
      // record() retries the mkdir: an unwritable data dir must not fail the boot.
    }
  }

  /** Appends one record. Returns the written entry, or null when it could not be written. */
  public record(input: AuditRecordInput): AuditEntry | null {
    try {
      const entry = this.normalize(input);
      this.rotateIfNeeded();
      this.appendLine(JSON.stringify(entry));
      return entry;
    } catch (err) {
      this.log.warn('Не удалось записать запись аудита: ' + errorText(err));
      return null;
    }
  }

  private normalize(input: AuditRecordInput): AuditEntry {
    const action = typeof input.action === 'string' ? input.action.trim() : '';
    if (!action) throw new Error('пустое поле action');

    const title = redactText(typeof input.title === 'string' ? input.title.trim() : '');
    const provided = typeof input.at === 'string' ? Date.parse(input.at) : Number.NaN;
    const at = Number.isNaN(provided) ? new Date().toISOString() : new Date(provided).toISOString();
    const actor = ACTORS.includes(input.actor as AuditActor) ? (input.actor as AuditActor) : 'auto';
    const outcome = OUTCOMES.includes(input.outcome as AuditOutcome)
      ? (input.outcome as AuditOutcome)
      : 'ok';
    const details = sanitizeDetails(input.details);

    return details
      ? { at, action, actor, outcome, title, details }
      : { at, action, actor, outcome, title };
  }

  /** One append per line, synced before returning so a crash cannot lose the record. */
  private appendLine(line: string): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // 'a+' (not 'a'): the torn-line probe below reads the last byte, and a write-only
    // descriptor cannot be read on every platform.
    const fd = fs.openSync(this.filePath, 'a+');
    try {
      const size = fs.fstatSync(fd).size;
      // A crash during a previous append may have left a torn last line; without the
      // newline the next record would be glued to it and neither line would parse.
      if (size > 0) {
        const tail = Buffer.alloc(1);
        fs.readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) fs.writeSync(fd, '\n');
      }
      fs.writeFileSync(fd, line + '\n', 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Newest-first slice of the file tail; never parses the whole file.
   *
   * The parameter stays optional (not defaulted) on purpose: duck-typed consumers such
   * as the web dashboard probe `list.length` to decide whether they may pass options,
   * and a default value would make that probe report 0.
   */
  public list(options?: AuditListOptions): AuditEntry[] {
    try {
      const opts = options ?? {};
      const limit = positiveInteger(opts.limit, DEFAULT_LIST_LIMIT);
      const sinceMs = toTimestampMs(opts.since);
      const action =
        typeof opts.action === 'string' && opts.action.length > 0 ? opts.action : undefined;
      return this.readTail(limit, sinceMs, action);
    } catch (err) {
      this.log.warn('Не удалось прочитать журнал аудита: ' + errorText(err));
      return [];
    }
  }

  /**
   * Reads the last complete lines of the file only. The window grows geometrically
   * while a filter matches too little, so a huge log is never parsed whole just to
   * return the newest five records.
   */
  private readTail(
    limit: number,
    sinceMs: number | undefined,
    action: string | undefined,
  ): AuditEntry[] {
    let fd: number;
    try {
      fd = fs.openSync(this.filePath, 'r');
    } catch {
      return [];
    }

    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) return [];

      let windowBytes = Math.min(size, Math.max(MIN_TAIL_WINDOW, limit * 512));
      for (;;) {
        const start = size - windowBytes;
        const buffer = Buffer.alloc(windowBytes);
        fs.readSync(fd, buffer, 0, windowBytes, start);
        const lines = buffer
          .toString('utf8')
          .split('\n')
          .filter((line) => line.length > 0);
        // A window that starts mid-file may start mid-line; drop that torn first line.
        const complete = start > 0 ? lines.slice(1) : lines;
        const found = this.collect(complete, limit, sinceMs, action);
        if (found.length >= limit || start === 0) return found;
        if (windowBytes >= size) return found;
        windowBytes = Math.min(size, windowBytes * 4);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Newest-first scan of the given lines, stopping at limit matches. */
  private collect(
    lines: string[],
    limit: number,
    sinceMs: number | undefined,
    action: string | undefined,
  ): AuditEntry[] {
    const found: AuditEntry[] = [];
    for (let index = lines.length - 1; index >= 0 && found.length < limit; index -= 1) {
      const entry = parseLine(lines[index]);
      if (!entry) continue;
      if (action !== undefined && entry.action !== action) continue;
      if (sinceMs !== undefined) {
        const at = Date.parse(entry.at);
        if (Number.isNaN(at) || at < sinceMs) continue;
      }
      found.push(entry);
    }
    return found;
  }

  /** Empties the live log and drops the archive. */
  public clear(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Truncate instead of unlink: an operator running tail -f keeps its handle.
      fs.writeFileSync(this.filePath, '', 'utf8');
      fs.rmSync(this.archivePath, { force: true });
    } catch (err) {
      this.log.warn('Не удалось очистить журнал аудита: ' + errorText(err));
    }
  }

  /** Counts and bounds of the live file (the archive is not included). */
  public stats(): AuditStats {
    let fileSize: number;
    try {
      fileSize = fs.statSync(this.filePath).size;
    } catch {
      return { entries: 0, total: 0, bytes: 0, byAction: [], byOutcome: [] };
    }

    let entries = 0;
    let oldestAt: string | undefined;
    let newestAt: string | undefined;
    let oldestMs = Number.POSITIVE_INFINITY;
    let newestMs = Number.NEGATIVE_INFINITY;
    const byAction = new Map<string, number>();
    const byOutcome = new Map<string, number>();

    try {
      for (const line of fs.readFileSync(this.filePath, 'utf8').split('\n')) {
        if (!line) continue;
        const entry = parseLine(line);
        if (!entry) continue;
        entries += 1;
        byAction.set(entry.action, (byAction.get(entry.action) ?? 0) + 1);
        byOutcome.set(entry.outcome, (byOutcome.get(entry.outcome) ?? 0) + 1);
        const ms = Date.parse(entry.at);
        if (Number.isNaN(ms)) continue;
        if (ms < oldestMs) {
          oldestMs = ms;
          oldestAt = entry.at;
        }
        if (ms > newestMs) {
          newestMs = ms;
          newestAt = entry.at;
        }
      }
    } catch (err) {
      this.log.warn('Не удалось посчитать записи аудита: ' + errorText(err));
    }

    const toBuckets = (counters: Map<string, number>): Array<{ key: string; count: number }> =>
      [...counters.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));

    const result: AuditStats = {
      entries,
      total: entries,
      bytes: fileSize,
      byAction: toBuckets(byAction),
      byOutcome: toBuckets(byOutcome),
    };
    if (oldestAt !== undefined) result.oldestAt = oldestAt;
    if (newestAt !== undefined) result.newestAt = newestAt;
    return result;
  }

  /**
   * Rewrites the file keeping the newest entries: inside the age window, within
   * maxEntries and within maxBytes. Malformed lines are dropped here.
   */
  public prune(options: AuditPruneOptions = {}): AuditPruneResult {
    const unchanged: AuditPruneResult = { removed: 0, kept: 0, bytes: 0 };
    try {
      const maxEntries = positiveInteger(options.maxEntries, AUDIT_MAX_ENTRIES);
      const maxBytes = positiveInteger(options.maxBytes, AUDIT_MAX_BYTES);
      const maxAgeDays =
        options.maxAgeDays === undefined || options.maxAgeDays <= 0 ? 0 : options.maxAgeDays;
      const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000 : undefined;

      let raw: string;
      try {
        raw = fs.readFileSync(this.filePath, 'utf8');
      } catch {
        return unchanged;
      }

      const kept: Array<{ line: string; at: number }> = [];
      let removed = 0;

      for (const line of raw.split('\n')) {
        if (!line) continue;
        const entry = parseLine(line);
        if (!entry) {
          removed += 1;
          continue;
        }
        const at = Date.parse(entry.at);
        if (cutoff !== undefined && (Number.isNaN(at) || at < cutoff)) {
          removed += 1;
          continue;
        }
        kept.push({ line, at: Number.isNaN(at) ? 0 : at });
      }

      // Newest first for the retention cut; the sort is stable, so entries with an
      // identical timestamp keep their append order.
      kept.sort((left, right) => right.at - left.at);
      const survivors = kept.slice(0, maxEntries);
      removed += kept.length - survivors.length;

      // Byte budget: drop from the old end until the rewritten file fits.
      let total = 0;
      for (const item of survivors) total += Buffer.byteLength(item.line, 'utf8') + 1;
      while (survivors.length > 0 && total > maxBytes) {
        const dropped = survivors.pop();
        if (!dropped) break;
        total -= Buffer.byteLength(dropped.line, 'utf8') + 1;
        removed += 1;
      }

      // Back to append order (oldest -> newest) before writing.
      survivors.reverse();
      const payload = survivors.length > 0 ? survivors.map((item) => item.line).join('\n') + '\n' : '';
      this.writeAtomic(payload);
      return { removed, kept: survivors.length, bytes: Buffer.byteLength(payload, 'utf8') };
    } catch (err) {
      this.log.warn('Не удалось обрезать журнал аудита: ' + errorText(err));
      return unchanged;
    }
  }

  /**
   * Renames the log over the threshold to audit.jsonl.1 (one archive, overwritten).
   * Called before every append, so the live file never grows past maxBytes by much.
   */
  public rotateIfNeeded(): boolean {
    try {
      if (fs.statSync(this.filePath).size <= this.maxBytes) return false;
      return this.rotate();
    } catch {
      return false;
    }
  }

  /** Rotates unconditionally; returns true when a file was moved to the archive. */
  public rotate(): boolean {
    try {
      if (!fs.existsSync(this.filePath)) return false;
      fs.rmSync(this.archivePath, { force: true });
      fs.renameSync(this.filePath, this.archivePath);
      this.log.info('Журнал аудита повёрнут: ' + path.basename(this.archivePath));
      return true;
    } catch (err) {
      this.log.warn('Не удалось повернуть журнал аудита: ' + errorText(err));
      return false;
    }
  }

  private writeAtomic(payload: string): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(
      dir,
      '.' +
        path.basename(this.filePath) +
        '.' +
        String(process.pid) +
        '.' +
        crypto.randomBytes(6).toString('hex') +
        '.tmp',
    );
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.filePath);
  }
}
