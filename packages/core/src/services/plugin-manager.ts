import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context, Service, type Component, type Fiber } from 'cordis';
import type { ExternalPluginMeta, LoadedPluginRecord, PluginCheckResult } from '../types/models.js';

export interface PluginManagerConfig {
  pluginsDir?: string;
}

export interface ExternalPluginModule {
  meta?: Partial<ExternalPluginMeta>;
  default?: Component;
  apply?: (ctx: Context, config?: unknown) => void | Promise<void>;
  inject?: string[];
  name?: string;
}

interface ManagedPluginEntry {
  record: LoadedPluginRecord;
  component: Component | null;
  fiber: Fiber | null;
}

function safePluginId(filename: string): string {
  const base = path.basename(filename).replace(/\.(mjs|js|zip)$/i, '');
  const clean = base.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!clean) return `plugin_${Date.now().toString(36)}`;
  return /^\d/.test(clean) ? `plugin_${clean}` : clean;
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

  public async register(
    meta: ExternalPluginMeta,
    component: Component,
    sourcePath = 'builtin',
  ): Promise<LoadedPluginRecord> {
    const record: LoadedPluginRecord = {
      id: meta.id,
      meta,
      enabled: false,
      sourcePath,
    };
    this.entries.set(meta.id, { record, component, fiber: null });

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
          ? {
              name: mod.meta?.name ?? mod.name ?? id,
              inject: mod.inject,
              apply: mod.apply,
            }
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
      this.entries.set(id, { record, component, fiber: null });

      if (!disabled.includes(id)) {
        await this.enable(id, false);
      } else {
        this.log.info(`Плагин ${meta.name} выключен в настройках — пропускаю`);
      }
      return { ...record };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Ошибка загрузки плагина ${id}: ${message}`);
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
   * Verifies a plugin file in an isolated Node subprocess with timeout before activating it in the live bot.
   */
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

  /**
   * Installs or updates a single `.mjs`/`.js` plugin with automatic backup, isolated check, and rollback on failure.
   */
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
      // Rollback cleanly so live bot stays healthy
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

    let removed = false;
    for (const candidate of [
      path.join(this.pluginsDir, `${id}.mjs`),
      path.join(this.pluginsDir, `${id}.js`),
      path.join(this.pluginsDir, id),
    ]) {
      if (fs.existsSync(candidate)) {
        fs.rmSync(candidate, { recursive: true, force: true });
        removed = true;
      }
    }
    return removed || Boolean(entry);
  }

  public async enable(id: string, persist = true): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry || !entry.component) return false;
    if (entry.record.enabled && entry.fiber) return true;

    try {
      const fiber = this.ctx.use(entry.component);
      await fiber;
      entry.fiber = fiber;
      entry.record.enabled = true;
      entry.record.error = undefined;

      if (persist) {
        this.setPersistedDisabled(id, false);
      }

      this.log.info(`Плагин ${entry.record.meta.name} v${entry.record.meta.version} включён`);
      await this.ctx.parallel('bot/module-enabled', { ...entry.record });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.record.error = message;
      this.log.error(`Не удалось включить плагин ${id}: ${message}`);
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
