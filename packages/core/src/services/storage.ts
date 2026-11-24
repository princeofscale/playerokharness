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
    } catch {
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

  constructor(ctx: Context, config: StorageConfig) {
    super(ctx, 'storage');
    this.baseDir = path.resolve(config.baseDir);
    this.registerBuiltInStores();
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
  }

  public registerStore<T>(spec: StoreSpec<T>): void {
    this.specs.set(spec.name, spec as StoreSpec<unknown>);
  }

  public resolvePath(relativePath: string): string {
    return path.join(this.baseDir, relativePath);
  }

  public getStorePath(name: string): string {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`Unknown storage key: ${name}`);
    return this.resolvePath(spec.relativePath);
  }

  public get<T>(name: string): T {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`Unknown storage key: ${name}`);
    return readJsonSafe(
      this.resolvePath(spec.relativePath),
      spec.schema as z.ZodType<T>,
      spec.defaultValue as () => T,
      spec.restoreMissing,
    );
  }

  public set<T>(name: string, value: T): T {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`Unknown storage key: ${name}`);
    const parsed = (spec.schema as z.ZodType<T>).parse(value);
    writeJsonAtomic(this.resolvePath(spec.relativePath), parsed);
    return parsed;
  }

  public update<T>(name: string, updater: (current: T) => T | void): T {
    const current = this.get<T>(name);
    const next = updater(current);
    return this.set<T>(name, next === undefined ? current : next);
  }

  // Typed convenience accessors
  public getConfig(): BotConfig {
    return this.get<BotConfig>('config');
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
