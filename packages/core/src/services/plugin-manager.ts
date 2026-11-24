import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context, Service, type Component, type Fiber } from 'cordis';
import type { z } from 'zod';
import type { BotConfig } from '../schemas/settings.js';
import type { ExternalPluginMeta, LoadedPluginRecord, PluginCheckResult } from '../types/models.js';
import type { StorageService } from './storage.js';

export interface PluginManagerConfig {
  pluginsDir?: string;
}

export interface ExternalPluginModule {
  meta?: Partial<ExternalPluginMeta>;
  Config?: z.ZodType<any>;
  default?: Component;
  apply?: (ctx: Context, config?: any) => void | Promise<void>;
  inject?: string[];
  name?: string;
}

export class PluginPermissionError extends Error {
  constructor(pluginId: string, resource: string) {
    super(
      `Плагин «${pluginId}» не является доверенным (plugins.trusted) и не имеет доступа к «${resource}»`,
    );
    this.name = 'PluginPermissionError';
  }
}

export class PluginConfigValidationError extends Error {
  constructor(pluginId: string, details: string) {
    super(`Некорректная конфигурация плагина «${pluginId}»: ${details}`);
    this.name = 'PluginConfigValidationError';
  }
}

interface ManagedPluginEntry {
  record: LoadedPluginRecord;
  component: Component | null;
  configSchema?: z.ZodType<any>;
  trusted: boolean;
  fiber: Fiber | null;
}

const RESTRICTED_SERVICES = new Set(['autoWithdrawal', 'access', 'lock']);
// 'idempotency' holds the double-delivery / double-complete guards: letting an
// untrusted plugin rewrite it would defeat the money-safety net.
const RESTRICTED_STORAGE_KEYS = new Set(['owner_link', 'access_requests', 'config', 'idempotency']);
// Direct mutators bypass the per-key checks above, so they are blocked explicitly.
const RESTRICTED_STORAGE_METHODS = new Set([
  'markDealDelivered',
  'markDealCompleted',
  'rebindItem',
  'getStorePath',
]);

const isClassComponent = (value: unknown): boolean =>
  typeof value === 'function' && /^class\b/.test(Function.prototype.toString.call(value));

function safePluginId(filename: string): string {
  const base = path.basename(filename).replace(/\.(mjs|js|zip)$/i, '');
  const clean = base.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!clean) return `plugin_${Date.now().toString(36)}`;
  return /^\d/.test(clean) ? `plugin_${clean}` : clean;
}

function redactConfigForUntrusted(cfg: BotConfig): BotConfig {
  const copy = structuredClone(cfg);
  copy.telegram.api.token = '';
  copy.telegram.bot.password = '';
  copy.playerok.api.cookies = '';
  return copy;
}

function createRestrictedStorageProxy(pluginId: string, storage: StorageService): StorageService {
  return new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop === 'getConfig') {
        return () => redactConfigForUntrusted(target.getConfig());
      }
      if (
        prop === 'setConfig' ||
        prop === 'updateConfig' ||
        prop === 'exportSnapshot' ||
        // registerStore() would let a plugin re-register "config" (or any store) with a
        // permissive schema / an escaping relativePath and then write it via set().
        prop === 'registerStore' ||
        (typeof prop === 'string' && RESTRICTED_STORAGE_METHODS.has(prop))
      ) {
        return () => {
          throw new PluginPermissionError(pluginId, `storage.${String(prop)}`);
        };
      }
      if (prop === 'get' || prop === 'set' || prop === 'update') {
        return (name: string, ...rest: unknown[]) => {
          if (RESTRICTED_STORAGE_KEYS.has(name)) {
            throw new PluginPermissionError(pluginId, `storage.${String(prop)}("${name}")`);
          }
          return (target as any)[prop](name, ...rest);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

function createRestrictedContext(
  pluginId: string,
  baseCtx: Context,
  rootStorage: StorageService,
): Context {
  const storageProxy = createRestrictedStorageProxy(pluginId, rootStorage);

  return new Proxy(baseCtx, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') {
        if (RESTRICTED_SERVICES.has(prop)) {
          throw new PluginPermissionError(pluginId, `ctx.${prop}`);
        }
        if (prop === 'storage') {
          return storageProxy;
        }
        if (prop === 'get') {
          // ctx.get('storage') / ctx.get('access') used to return the real service,
          // bypassing both the storage proxy and the restricted-service check.
          return (name: string, strict?: boolean) => {
            if (name === 'storage') return storageProxy;
            if (RESTRICTED_SERVICES.has(name)) {
              throw new PluginPermissionError(pluginId, `ctx.get("${name}")`);
            }
            return (target as unknown as { get(name: string, strict?: boolean): unknown }).get(name, strict);
          };
        }
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

export class PluginManagerService extends Service {
  static provide = 'plugins';
  static inject = ['storage'];

  public readonly pluginsDir: string;
  public readonly backupDir: string;
  private readonly log;
  private readonly entries = new Map<string, ManagedPluginEntry>();

  constructor(ctx: Context, config: PluginManagerConfig = {}) {
    super(ctx, 'plugins');
    this.log = ctx.logger('plugins');
    this.pluginsDir = config.pluginsDir
      ? path.resolve(config.pluginsDir)
      : ctx.storage.resolvePath('plugins');
    this.backupDir = ctx.storage.resolvePath('bot_data/.plugins_backup');

    ctx.effect(() => {
      return async () => {
        for (const entry of this.entries.values()) {
          if (entry.fiber) {
            await entry.fiber.dispose();
            entry.fiber = null;
            entry.record.enabled = false;
          }
        }
      };
    }, 'plugins:disposeAll');
  }

  public list(): LoadedPluginRecord[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e.record }));
  }

  public get(id: string): LoadedPluginRecord | null {
    const entry = this.entries.get(id);
    return entry ? { ...entry.record } : null;
  }

  public isTrusted(id: string): boolean {
    const trusted = this.ctx.storage.getConfig().plugins.trusted;
    return trusted.includes(id) || trusted.includes('*');
  }

  private loadPluginConfig(id: string, schema?: z.ZodType<any>): unknown {
    const cfgPath = this.ctx.storage.resolvePath(`bot_settings/plugins/${id}.json`);
    let raw: unknown = {};
    if (fs.existsSync(cfgPath)) {
      try {
        raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      } catch (err) {
        throw new PluginConfigValidationError(
          id,
          `некорректный JSON в ${cfgPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!schema) return raw;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new PluginConfigValidationError(id, details);
    }
    return parsed.data;
  }

  public async register(
    meta: ExternalPluginMeta,
    component: Component,
    sourcePath = 'builtin',
    options: { trusted?: boolean; configSchema?: z.ZodType<any> } = {},
  ): Promise<LoadedPluginRecord> {
    const record: LoadedPluginRecord = {
      id: meta.id,
      meta,
      enabled: false,
      sourcePath,
    };
    const trusted = options.trusted ?? (sourcePath === 'builtin' || this.isTrusted(meta.id));
    this.entries.set(meta.id, {
      record,
      component,
      configSchema: options.configSchema,
      trusted,
      fiber: null,
    });

    const disabled = this.ctx.storage.getDisabledModules();
    if (!disabled.includes(meta.id)) {
      await this.enable(meta.id, false);
    }
    return { ...record };
  }

  private async importPluginFile(id: string, entryFile: string, bustCache = false): Promise<LoadedPluginRecord> {
    const disabled = this.ctx.storage.getDisabledModules();
    const url = pathToFileURL(entryFile).href + (bustCache ? `?t=${Date.now()}` : '');

    try {
      const mod = (await import(url)) as ExternalPluginModule;
      const component: Component | null =
        mod.default ??
        (typeof mod.apply === 'function'
          ? ({
              name: mod.meta?.name ?? mod.name ?? id,
              inject: mod.inject,
              // cordis awaits the returned value; the static Component type declares void.
              apply: (c: Context, cfg: unknown) => mod.apply!(c, cfg),
            } as unknown as Component)
          : null);

      if (!component) {
        throw new Error('Plugin must export default component or apply(ctx) function');
      }

      const meta: ExternalPluginMeta = {
        id,
        name: mod.meta?.name ?? mod.name ?? id,
        version: mod.meta?.version ?? '1.0.0',
        description: mod.meta?.description ?? '',
        authors: mod.meta?.authors ?? '',
        links: mod.meta?.links ?? '',
        prefix: mod.meta?.prefix ?? `[${id}]`,
      };

      const record: LoadedPluginRecord = {
        id,
        meta,
        enabled: false,
        sourcePath: entryFile,
      };
      this.entries.set(id, {
        record,
        component,
        configSchema: mod.Config,
        trusted: this.isTrusted(id),
        fiber: null,
      });

      if (!disabled.includes(id)) {
        await this.enable(id, false);
      } else {
        this.log.info(`Плагин ${meta.name} выключен в настройках — пропускаю`);
      }
      return { ...record };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const trace = err instanceof Error ? err.stack || message : message;
      this.log.error(`Ошибка загрузки плагина ${id}: ${message}`);
      this.ctx.get('bootReport', false)?.addError(id, 'load', trace);
      const failedRecord: LoadedPluginRecord = {
        id,
        meta: { id, name: id, version: '—' },
        enabled: false,
        sourcePath: entryFile,
        error: message,
      };
      this.entries.set(id, {
        record: failedRecord,
        component: null,
        trusted: false,
        fiber: null,
      });
      return failedRecord;
    }
  }

  public async discoverAndLoad(): Promise<LoadedPluginRecord[]> {
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    const dirEntries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });

    for (const dirent of dirEntries) {
      if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;

      let entryFile: string | null = null;
      let id: string;

      if (dirent.isDirectory()) {
        id = dirent.name;
        for (const candidate of ['index.mjs', 'index.js']) {
          const full = path.join(this.pluginsDir, dirent.name, candidate);
          if (fs.existsSync(full)) {
            entryFile = full;
            break;
          }
        }
      } else if (dirent.isFile() && /\.(mjs|js)$/.test(dirent.name)) {
        id = dirent.name.replace(/\.(mjs|js)$/, '');
        entryFile = path.join(this.pluginsDir, dirent.name);
      } else {
        continue;
      }

      if (!entryFile || this.entries.has(id)) continue;
      await this.importPluginFile(id, entryFile);
    }

    return this.list();
  }

  /**
   * Ensures every plugin listed in `config.plugins.required` was found, validated, and enabled.
   * Throws an explicit diagnostic Error if any required plugin is missing or failed to start.
   */
  public verifyRequiredPlugins(): void {
    const required = this.ctx.storage.getConfig().plugins.required;
    const problems: string[] = [];

    for (const id of required) {
      const entry = this.entries.get(id);
      if (!entry) {
        problems.push(`${id}: плагин не найден в ${this.pluginsDir}`);
      } else if (entry.record.error) {
        problems.push(`${id}: ${entry.record.error}`);
      } else if (!entry.record.enabled) {
        problems.push(`${id}: плагин не активен`);
      }
    }

    if (problems.length > 0) {
      throw new Error(`Не загружены обязательные плагины: ${problems.join(' | ')}`);
    }
  }

  public async checkPluginFile(filePath: string, timeoutMs = 15_000): Promise<PluginCheckResult> {
    const id = safePluginId(filePath);
    const hasBackup = fs.existsSync(path.join(this.backupDir, `${id}.mjs`));
    const fileUrl = pathToFileURL(path.resolve(filePath)).href;

    const script = `
      const mod = await import(${JSON.stringify(fileUrl)});
      const ok = Boolean(mod.default || typeof mod.apply === 'function');
      if (!ok) {
        console.error('Plugin must export default component or apply(ctx) function');
        process.exit(1);
      }
      process.exit(0);
    `;

    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        resolve({ id, status: 'timeout', trace: `Проверка превысила таймаут ${timeoutMs}мс`, hasBackup });
      }, timeoutMs);

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ id, status: 'error', trace: err.message, hasBackup });
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve({ id, status: 'ok', hasBackup });
        } else {
          resolve({ id, status: 'error', trace: stderr.trim().slice(-2000), hasBackup });
        }
      });
    });
  }

  public async installPluginFile(
    filename: string,
    content: Buffer | string,
  ): Promise<{ id: string; check: PluginCheckResult; record?: LoadedPluginRecord }> {
    if (!/\.(mjs|js)$/i.test(filename)) {
      throw new Error('Поддерживаются только файлы плагинов .mjs или .js');
    }

    fs.mkdirSync(this.pluginsDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });

    const id = safePluginId(filename);
    const ext = filename.toLowerCase().endsWith('.js') ? '.js' : '.mjs';
    const destPath = path.join(this.pluginsDir, `${id}${ext}`);
    const backupPath = path.join(this.backupDir, `${id}.mjs`);

    const existed = fs.existsSync(destPath);
    if (existed) {
      fs.copyFileSync(destPath, backupPath);
    }

    const prevEntry = this.entries.get(id);
    if (prevEntry?.fiber) {
      await prevEntry.fiber.dispose();
      prevEntry.fiber = null;
      prevEntry.record.enabled = false;
    }

    fs.writeFileSync(destPath, content);
    const check = await this.checkPluginFile(destPath);

    if (check.status !== 'ok') {
      if (existed && fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, destPath);
        await this.importPluginFile(id, destPath, true);
      } else {
        fs.rmSync(destPath, { force: true });
      }
      return { id, check };
    }

    if (fs.existsSync(backupPath)) {
      fs.rmSync(backupPath, { force: true });
    }

    this.setPersistedDisabled(id, false);
    const record = await this.importPluginFile(id, destPath, true);
    return { id, check, record };
  }

  public async removePlugin(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (entry?.fiber) {
      await entry.fiber.dispose();
    }
    this.entries.delete(id);
    this.setPersistedDisabled(id, false);

    // `id` comes from settings/UI callbacks; never let it escape pluginsDir.
    const candidates = [
      path.join(this.pluginsDir, `${id}.mjs`),
      path.join(this.pluginsDir, `${id}.js`),
      path.join(this.pluginsDir, id),
    ].map((candidate) => path.resolve(candidate));
    const insidePluginsDir = (candidate: string): boolean =>
      candidate === this.pluginsDir || candidate.startsWith(`${this.pluginsDir}${path.sep}`);

    let removed = false;
    for (const candidate of candidates) {
      if (!insidePluginsDir(candidate)) continue;
      if (fs.existsSync(candidate)) {
        fs.rmSync(candidate, { recursive: true, force: true });
        removed = true;
      }
    }
    return removed || Boolean(entry);
  }

  private wrapWithPermissions(id: string, component: Component, trusted: boolean): Component {
    if (trusted) return component;
    const raw = component as Component.Object & Component.Function & { inject?: string[]; name?: string };
    const rootStorage = this.ctx.storage;
    return {
      name: raw.name ?? id,
      inject: raw.inject,
      apply: (childCtx: Context, cfg: unknown) => {
        const restrictedCtx = createRestrictedContext(id, childCtx, rootStorage);
        if (isClassComponent(component)) {
          // Service subclasses cannot be invoked without the new operator; calling one
          // threw a bare TypeError, so every untrusted class component was dead on arrival.
          const Ctor = component as unknown as new (ctx: Context, cfg: unknown) => unknown;
          return new Ctor(restrictedCtx, cfg);
        }
        if (typeof component === 'function') {
          return (component as (ctx: Context, cfg: unknown) => unknown)(restrictedCtx, cfg);
        }
        return (component as Component.Object).apply(restrictedCtx, cfg);
      },
    };
  }

  public async enable(id: string, persist = true): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry || !entry.component) return false;
    if (entry.record.enabled && entry.fiber) return true;

    try {
      const validatedConfig = this.loadPluginConfig(id, entry.configSchema);
      const wrapped = this.wrapWithPermissions(id, entry.component, entry.trusted || this.isTrusted(id));
      const fiber = this.ctx.use(wrapped, validatedConfig);
      await fiber;
      entry.fiber = fiber;
      entry.record.enabled = true;
      entry.record.error = undefined;

      if (persist) {
        this.setPersistedDisabled(id, false);
      }

      this.log.info(
        `Плагин ${entry.record.meta.name} v${entry.record.meta.version} включён (${entry.trusted ? 'trusted' : 'restricted'})`,
      );
      await this.ctx.parallel('bot/module-enabled', { ...entry.record });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const trace = err instanceof Error ? err.stack || message : message;
      entry.record.error = message;
      this.log.error(`Не удалось включить плагин ${id}: ${message}`);
      this.ctx.get('bootReport', false)?.addError(id, 'start', trace);
      return false;
    }
  }

  public async disable(id: string, persist = true): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;

    if (entry.fiber) {
      await entry.fiber.dispose();
      entry.fiber = null;
    }
    entry.record.enabled = false;

    if (persist) {
      this.setPersistedDisabled(id, true);
    }

    this.log.info(`Плагин ${entry.record.meta.name} выключен`);
    await this.ctx.parallel('bot/module-disabled', { ...entry.record });
    return true;
  }

  private setPersistedDisabled(id: string, disabled: boolean): void {
    this.ctx.storage.update<string[]>('disabled_modules', (current) => {
      const has = current.includes(id);
      if (disabled && !has) return [...current, id];
      if (!disabled && has) return current.filter((x) => x !== id);
      return current;
    });
  }
}
