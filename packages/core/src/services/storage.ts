import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Context, Service } from 'cordis';
import { z } from 'zod';
import {
  AccessRequestsSchema,
  AutoDeliveriesSchema,
  BlacklistSettingsSchema,
  BootMarkerSchema,
  BotConfigSchema,
  BumpedItemsSchema,
  CachedOrdersSchema,
  CustomCommandsSchema,
  DataReplacementSchema,
  DEFAULT_CONFIG,
  DEFAULT_MESSAGES,
  FastRepliesSchema,
  IdempotencyStoreSchema,
  IncludeExcludeSchema,
  MessagesSettingsSchema,
  OwnerLinkSchema,
  type AccessRequests,
  type AutoDeliveryRule,
  type BlacklistSettings,
  type BootMarker,
  type BotConfig,
  type BoundItem,
  type BumpedItems,
  type CachedOrders,
  type CustomCommandsSettings,
  type DataReplacementRule,
  type FastReply,
  type IdempotencyStore,
  type IncludeExcludeSettings,
  type MessagesSettings,
  type OwnerLink,
} from '../schemas/settings.js';
import { rebindInObject } from '../utils/bindings.js';

export interface StorageConfig {
  baseDir: string;
}

export interface StoreSpec<T> {
  name: string;
  relativePath: string;
  schema: z.ZodType<T>;
  defaultValue: () => T;
  restoreMissing: boolean;
  exportable: boolean;
}

interface StoreCacheEntry {
  mtimeNs: bigint;
  size: bigint;
  revision: number;
  value: unknown;
}

const clone = <T>(value: T): T => structuredClone(value);

function deepMergeWithDefaults<T>(current: unknown, defaults: T): T {
  if (
    defaults === null ||
    typeof defaults !== 'object' ||
    Array.isArray(defaults)
  ) {
    return (typeof current === typeof defaults ? current : clone(defaults)) as T;
  }
  const result: Record<string, unknown> =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  for (const [key, defVal] of Object.entries(defaults as Record<string, unknown>)) {
    if (!(key in result) || result[key] === undefined) {
      result[key] = clone(defVal);
    } else if (
      defVal !== null &&
      typeof defVal === 'object' &&
      !Array.isArray(defVal) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMergeWithDefaults(result[key], defVal);
    } else if (typeof result[key] !== typeof defVal && typeof defVal !== 'undefined') {
      // Preserve string|number union for chat_id while restoring genuinely mismatched primitives
      if (!(key === 'chat_id' && (typeof result[key] === 'string' || typeof result[key] === 'number'))) {
        result[key] = clone(defVal);
      }
    }
  }
  return result as T;
}

export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

export function readJsonSafe<T>(
  filePath: string,
  schema: z.ZodType<T>,
  defaultValue: () => T,
  restoreMissing: boolean,
  onRecover?: (reason: string) => void,
): T {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(filePath)) {
    try {
      const rawText = fs.readFileSync(filePath, 'utf8');
      const parsedJson = JSON.parse(rawText);
      const candidate = restoreMissing
        ? deepMergeWithDefaults(parsedJson, defaultValue())
        : parsedJson;
      const result = schema.safeParse(candidate);
      if (result.success) {
        if (restoreMissing && JSON.stringify(parsedJson) !== JSON.stringify(result.data)) {
          writeJsonAtomic(filePath, result.data);
        }
        return result.data;
      }
      const firstIssue = result.error.issues[0];
      onRecover?.(
        `схема не совпала: ${firstIssue ? `${firstIssue.path.join('.') || '<root>'}: ${firstIssue.message}` : 'unknown'}`, 
      );
    } catch (err) {
      onRecover?.(`некорректный JSON: ${err instanceof Error ? err.message : String(err)}`);
      // Fall through to backup & restore
    }

    // Corrupt file: preserve .bak so user data is never silently lost
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    } catch {
      // ignore backup failure
    }
  }

  const fallback = defaultValue();
  writeJsonAtomic(filePath, fallback);
  return fallback;
}

/**
 * A settings screen commonly does `const cfg = getConfig(); ...; setConfig(cfg)`.
 * getConfig() returns the *effective* config with PKH_* overrides applied, so writing
 * it back would copy environment secrets into config.json on disk. Any field whose
 * value still equals the environment override is replaced by the empty string.
 */
function stripEnvSecrets(cfg: BotConfig): BotConfig {
  const env = process.env;
  const next = structuredClone(cfg);
  if (env.PKH_TELEGRAM_TOKEN && next.telegram.api.token === env.PKH_TELEGRAM_TOKEN) {
    next.telegram.api.token = '';
  }
  if (env.PKH_PLAYEROK_COOKIES && next.playerok.api.cookies === env.PKH_PLAYEROK_COOKIES) {
    next.playerok.api.cookies = '';
  }
  if (env.PKH_TELEGRAM_PROXY && next.telegram.api.proxy === env.PKH_TELEGRAM_PROXY) {
    next.telegram.api.proxy = '';
  }
  if (env.PKH_PLAYEROK_PROXY && next.playerok.api.proxy === env.PKH_PLAYEROK_PROXY) {
    next.playerok.api.proxy = '';
  }
  if (env.PKH_PLAYEROK_USER_AGENT && next.playerok.api.user_agent === env.PKH_PLAYEROK_USER_AGENT) {
    next.playerok.api.user_agent = '';
  }
  return next;
}

const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 5000;

/**
 * Keeps the double-delivery guards long enough to outlive any catch-up window
 * (30 days), instead of dropping the oldest *inserted* marker by count — which
 * could evict a recent deal and let a replayed NEW_DEAL deliver goods twice.
 */
export function pruneIdempotencyMarkers(map: Record<string, string>, now = Date.now()): void {
  for (const [dealId, iso] of Object.entries(map)) {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts) || now - ts > IDEMPOTENCY_TTL_MS) {
      delete map[dealId];
    }
  }

  const keys = Object.keys(map);
  if (keys.length <= IDEMPOTENCY_MAX_ENTRIES) return;

  keys.sort((a, b) => (Date.parse(map[a]) || 0) - (Date.parse(map[b]) || 0));
  for (const dealId of keys.slice(0, keys.length - IDEMPOTENCY_MAX_ENTRIES)) {
    delete map[dealId];
  }
}

export const BINDING_STORE_NAMES = [
  'auto_deliveries',
  'data_replacement',
  'auto_bump_items',
  'auto_restore_items',
  'auto_complete_deals',
] as const;

export class StorageService extends Service {
  static provide = 'storage';

  public readonly baseDir: string;
  private readonly specs: Map<string, StoreSpec<unknown>> = new Map();
  private readonly queues: Map<string, Promise<unknown>> = new Map();
  private readonly recoveredStores = new Set<string>();

  /**
   * Parsed-store cache: getConfig()/getMessages() run on every menu keystroke and each
   * call used to JSON.parse the file again. An entry stays valid while the file's
   * nanosecond mtime, its byte size and the in-process revision counter all match —
   * so a set() is visible on the very next read and an external edit is picked up.
   */
  public readonly storeCache = { hits: 0, misses: 0, writes: 0 };
  private readonly cache = new Map<string, StoreCacheEntry>();
  private readonly revisions = new Map<string, number>();

  constructor(ctx: Context, config: StorageConfig) {
    super(ctx, 'storage');
    this.baseDir = path.resolve(config.baseDir);
    this.registerBuiltInStores();
  }

  /**
   * Serializes read-modify-write operations on a given store key to prevent race conditions
   * when multiple order/message events are handled concurrently.
   */
  public async runExclusive<T>(storeKey: string, task: () => Promise<T> | T): Promise<T> {
    const prev = this.queues.get(storeKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => gate);
    this.queues.set(storeKey, chained);

    await prev;
    try {
      return await task();
    } finally {
      release();
      if (this.queues.get(storeKey) === chained) {
        this.queues.delete(storeKey);
      }
    }
  }

  private registerBuiltInStores(): void {
    // Settings (bot_settings/)
    this.registerStore<BotConfig>({
      name: 'config',
      relativePath: 'bot_settings/config.json',
      schema: BotConfigSchema,
      defaultValue: () => clone(DEFAULT_CONFIG),
      restoreMissing: true,
      exportable: true,
    });
    this.registerStore<MessagesSettings>({
      name: 'messages',
      relativePath: 'bot_settings/messages.json',
      schema: MessagesSettingsSchema,
      defaultValue: () => clone(DEFAULT_MESSAGES),
      restoreMissing: true,
      exportable: true,
    });
    this.registerStore<CustomCommandsSettings>({
      name: 'custom_commands',
      relativePath: 'bot_settings/custom_commands.json',
      schema: CustomCommandsSchema,
      defaultValue: () => ({}),
      restoreMissing: false,
      exportable: true,
    });
    this.registerStore<AutoDeliveryRule[]>({
      name: 'auto_deliveries',
      relativePath: 'bot_settings/auto_deliveries.json',
      schema: AutoDeliveriesSchema,
      defaultValue: () => [],
      restoreMissing: false,
      exportable: true,
    });
    this.registerStore<IncludeExcludeSettings>({
      name: 'auto_restore_items',
      relativePath: 'bot_settings/auto_restore_items.json',
      schema: IncludeExcludeSchema,
      defaultValue: () => ({ included: [], excluded: [] }),
      restoreMissing: false,
      exportable: true,
    });
    this.registerStore<IncludeExcludeSettings>({
      name: 'auto_complete_deals',
      relativePath: 'bot_settings/auto_complete_deals.json',
      schema: IncludeExcludeSchema,
      defaultValue: () => ({ included: [], excluded: [] }),
      restoreMissing: false,
      exportable: true,
    });
    this.registerStore<IncludeExcludeSettings>({
      name: 'auto_bump_items',
      relativePath: 'bot_settings/auto_bump_items.json',
      schema: IncludeExcludeSchema,
      defaultValue: () => ({ included: [], excluded: [] }),
      restoreMissing: false,
      exportable: true,
    });
    this.registerStore<FastReply[]>({
      name: 'fast_replies',
      relativePath: 'bot_settings/fast_replies.json',
      schema: FastRepliesSchema,
      defaultValue: () => [],
      restoreMissing: false,
      exportable: true,
    });
    this.registerStore<DataReplacementRule[]>({
      name: 'data_replacement',
      relativePath: 'bot_settings/data_replacement.json',
      schema: DataReplacementSchema,
      defaultValue: () => [],
      restoreMissing: false,
      exportable: true,
    });
    this.registerStore<BlacklistSettings>({
      name: 'blacklist',
      relativePath: 'bot_settings/blacklist.json',
      schema: BlacklistSettingsSchema,
      defaultValue: () => ({ users: {} }),
      restoreMissing: true,
      exportable: true,
    });

    // Runtime data (bot_data/)
    this.registerStore<string[]>({
      name: 'initialized_users',
      relativePath: 'bot_data/initialized_users.json',
      schema: z.array(z.string()),
      defaultValue: () => [],
      restoreMissing: false,
      exportable: true,
    });
    this.registerStore<unknown[]>({
      name: 'saved_items',
      relativePath: 'bot_data/saved_items.json',
      schema: z.array(z.unknown()),
      defaultValue: () => [],
      restoreMissing: false,
      exportable: true,
    });
    this.registerStore<CachedOrders>({
      name: 'cached_orders',
      relativePath: 'bot_data/cached_orders.json',
      schema: CachedOrdersSchema,
      defaultValue: () => ({}),
      restoreMissing: false,
      exportable: true,
    });
    this.registerStore<BumpedItems>({
      name: 'bumped_items',
      relativePath: 'bot_data/bumped_items.json',
      schema: BumpedItemsSchema,
      defaultValue: () => ({}),
      restoreMissing: false,
      exportable: true,
    });

    // System data (not exported in config backups)
    this.registerStore<BootMarker>({
      name: 'boot_marker',
      relativePath: 'bot_data/boot_marker.json',
      schema: BootMarkerSchema,
      defaultValue: () => ({}),
      restoreMissing: false,
      exportable: false,
    });
    this.registerStore<OwnerLink>({
      name: 'owner_link',
      relativePath: 'bot_data/owner_link.json',
      schema: OwnerLinkSchema,
      defaultValue: () => ({}),
      restoreMissing: false,
      exportable: false,
    });
    this.registerStore<AccessRequests>({
      name: 'access_requests',
      relativePath: 'bot_data/access_requests.json',
      schema: AccessRequestsSchema,
      defaultValue: () => ({}),
      restoreMissing: false,
      exportable: false,
    });
    this.registerStore<string[]>({
      name: 'disabled_modules',
      relativePath: 'bot_data/disabled_modules.json',
      schema: z.array(z.string()),
      defaultValue: () => [],
      restoreMissing: false,
      exportable: false,
    });
    this.registerStore<IdempotencyStore>({
      name: 'idempotency',
      relativePath: 'bot_data/idempotency.json',
      schema: IdempotencyStoreSchema,
      defaultValue: () => ({ delivered_deals: {}, completed_deals: {} }),
      restoreMissing: true,
      exportable: false,
    });
  }

  public registerStore<T>(spec: StoreSpec<T>): void {
    this.specs.set(spec.name, spec as StoreSpec<unknown>);
  }

  public resolvePath(relativePath: string): string {
    const resolved = path.resolve(this.baseDir, relativePath);
    const prefix = this.baseDir.endsWith(path.sep) ? this.baseDir : `${this.baseDir}${path.sep}`;
    if (resolved !== this.baseDir && !resolved.startsWith(prefix)) {
      throw new Error(`Путь «${relativePath}» выходит за пределы каталога данных`);
    }
    return resolved;
  }

  public getStorePath(name: string): string {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`Unknown storage key: ${name}`);
    return this.resolvePath(spec.relativePath);
  }

  private statSignature(filePath: string): { mtimeNs: bigint; size: bigint } | null {
    try {
      const stat = fs.statSync(filePath, { bigint: true });
      return { mtimeNs: stat.mtimeNs, size: stat.size };
    } catch {
      return null;
    }
  }

  private rememberParsed(name: string, filePath: string, value: unknown): void {
    const signature = this.statSignature(filePath);
    if (!signature) {
      this.cache.delete(name);
      return;
    }
    this.cache.set(name, {
      mtimeNs: signature.mtimeNs,
      size: signature.size,
      revision: this.revisions.get(name) ?? 0,
      value,
    });
  }

  public get<T>(name: string): T {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`Unknown storage key: ${name}`);

    const filePath = this.resolvePath(spec.relativePath);
    const revision = this.revisions.get(name) ?? 0;
    const cached = this.cache.get(name);
    const signature = this.statSignature(filePath);

    if (
      cached &&
      signature &&
      cached.revision === revision &&
      cached.mtimeNs === signature.mtimeNs &&
      cached.size === signature.size
    ) {
      this.storeCache.hits += 1;
      // Callers mutate what they get back (update(), rebindItem(), getConfig()+setConfig),
      // so a cached object is never handed out by reference.
      return clone(cached.value) as T;
    }

    this.storeCache.misses += 1;
    const parsed = readJsonSafe(
      filePath,
      spec.schema as z.ZodType<T>,
      spec.defaultValue as () => T,
      spec.restoreMissing,
      (reason) => this.reportRecovery(name, reason),
    );
    // Re-stat after the read: readJsonSafe rewrites the file for corrupt or
    // restoreMissing stores, so the signature must be taken from the final bytes.
    this.rememberParsed(name, filePath, clone(parsed));
    return parsed;
  }

  /**
   * A corrupt or schema-mismatched store used to be replaced with defaults silently:
   * the operator saw empty settings and no explanation. Report the first recovery per
   * store to the log and to the boot report (the .bak copy still holds the old file).
   */
  private reportRecovery(storeName: string, reason: string): void {
    if (this.recoveredStores.has(storeName)) return;
    this.recoveredStores.add(storeName);
    this.ctx
      .logger('storage')
      .warn(`Хранилище «${storeName}» восстановлено значениями по умолчанию (${reason}); старая копия — ${storeName}.bak`);
    this.ctx.get('bootReport', false)?.addError(storeName, 'recover', reason);
  }

  public set<T>(name: string, value: T): T {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`Unknown storage key: ${name}`);
    const safeValue = name === 'config' ? (stripEnvSecrets(value as BotConfig) as unknown as T) : value;
    const parsed = (spec.schema as z.ZodType<T>).parse(safeValue);
    const filePath = this.resolvePath(spec.relativePath);
    writeJsonAtomic(filePath, parsed);
    // mtime/size change on every write; the revision counter additionally covers
    // rewriting identical bytes on a filesystem with a coarse mtime.
    this.revisions.set(name, (this.revisions.get(name) ?? 0) + 1);
    this.storeCache.writes += 1;
    this.rememberParsed(name, filePath, clone(parsed));
    return parsed;
  }

  public update<T>(name: string, updater: (current: T) => T | void): T {
    const current = this.get<T>(name);
    const next = updater(current);
    return this.set<T>(name, next === undefined ? current : next);
  }

  // Typed convenience accessors (with environment variable secret overrides).
  //
  // The overrides are applied to a *copy*: the previous version mutated the parsed
  // object, so any caller that handed that object back to setConfig() persisted the
  // environment secrets into config.json.
  public getConfig(): BotConfig {
    const stored = this.get<BotConfig>('config');
    const env = process.env;
    const overrides = {
      token: env.PKH_TELEGRAM_TOKEN,
      apiUrl: env.PKH_TELEGRAM_API_URL,
      tgProxy: env.PKH_TELEGRAM_PROXY,
      cookies: env.PKH_PLAYEROK_COOKIES,
      pokeProxy: env.PKH_PLAYEROK_PROXY,
      userAgent: env.PKH_PLAYEROK_USER_AGENT,
    };
    if (Object.values(overrides).every((value) => !value)) {
      return stored;
    }

    return {
      ...stored,
      telegram: {
        ...stored.telegram,
        api: {
          ...stored.telegram.api,
          token: overrides.token || stored.telegram.api.token,
          custom_api_url: overrides.apiUrl || stored.telegram.api.custom_api_url,
          proxy: overrides.tgProxy || stored.telegram.api.proxy,
        },
      },
      playerok: {
        ...stored.playerok,
        api: {
          ...stored.playerok.api,
          cookies: overrides.cookies || stored.playerok.api.cookies,
          proxy: overrides.pokeProxy || stored.playerok.api.proxy,
          user_agent: overrides.userAgent || stored.playerok.api.user_agent,
        },
      },
    };
  }

  public isDealDelivered(dealId: string): boolean {
    const store = this.get<IdempotencyStore>('idempotency');
    return Boolean(store.delivered_deals[dealId]);
  }

  public markDealDelivered(dealId: string): void {
    this.update<IdempotencyStore>('idempotency', (store) => {
      store.delivered_deals[dealId] = new Date().toISOString();
      pruneIdempotencyMarkers(store.delivered_deals);
    });
  }

  public isDealCompleted(dealId: string): boolean {
    const store = this.get<IdempotencyStore>('idempotency');
    return Boolean(store.completed_deals[dealId]);
  }

  public markDealCompleted(dealId: string): void {
    this.update<IdempotencyStore>('idempotency', (store) => {
      store.completed_deals[dealId] = new Date().toISOString();
      pruneIdempotencyMarkers(store.completed_deals);
    });
  }

  public setConfig(config: BotConfig): BotConfig {
    return this.set<BotConfig>('config', config);
  }

  public updateConfig(updater: (cfg: BotConfig) => BotConfig | void): BotConfig {
    return this.update<BotConfig>('config', updater);
  }

  public getMessages(): MessagesSettings {
    return this.get<MessagesSettings>('messages');
  }

  public getCustomCommands(): CustomCommandsSettings {
    return this.get<CustomCommandsSettings>('custom_commands');
  }

  public getAutoDeliveries(): AutoDeliveryRule[] {
    return this.get<AutoDeliveryRule[]>('auto_deliveries');
  }

  public getAutoRestoreItems(): IncludeExcludeSettings {
    return this.get<IncludeExcludeSettings>('auto_restore_items');
  }

  public getAutoCompleteDeals(): IncludeExcludeSettings {
    return this.get<IncludeExcludeSettings>('auto_complete_deals');
  }

  public getAutoBumpItems(): IncludeExcludeSettings {
    return this.get<IncludeExcludeSettings>('auto_bump_items');
  }

  public getFastReplies(): FastReply[] {
    return this.get<FastReply[]>('fast_replies');
  }

  public getDataReplacement(): DataReplacementRule[] {
    return this.get<DataReplacementRule[]>('data_replacement');
  }

  public getBlacklist(): BlacklistSettings {
    return this.get<BlacklistSettings>('blacklist');
  }

  public getInitializedUsers(): string[] {
    return this.get<string[]>('initialized_users');
  }

  public getCachedOrders(): CachedOrders {
    return this.get<CachedOrders>('cached_orders');
  }

  public getBumpedItems(): BumpedItems {
    return this.get<BumpedItems>('bumped_items');
  }

  public getDisabledModules(): string[] {
    return this.get<string[]>('disabled_modules');
  }

  /**
   * Rebinds an item across all binding settings stores after item recreation.
   */
  public rebindItem(oldId: string, next: BoundItem): number {
    if (!oldId || !next.id || oldId === next.id) return 0;
    let total = 0;
    for (const storeName of BINDING_STORE_NAMES) {
      const value = this.get<unknown>(storeName);
      const count = rebindInObject(value, oldId, next);
      if (count > 0) {
        this.set(storeName, value);
        total += count;
      }
    }
    return total;
  }

  /**
   * Exports all user-facing settings & data into a single JSON snapshot.
   */
  public exportSnapshot(): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};
    for (const [name, spec] of this.specs.entries()) {
      if (!spec.exportable) continue;
      snapshot[name] = this.get(name);
    }
    return snapshot;
  }
}
