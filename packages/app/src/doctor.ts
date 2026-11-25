import fs from 'node:fs';
import path from 'node:path';
import {
  Context,
  isCookiesValid,
  isTgTokenValid,
  pluginIntegrityManifestPath,
  StorageService,
  VERSION,
  verifyPluginIntegrity,
  type BootMarker,
  type PluginIntegrityResult,
} from '@pkh/core';

export interface DoctorCheck {
  /** Stable id so scripts can key off a check without parsing the Russian label. */
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface DoctorQueueState {
  pending: number;
  dead: number;
}

export interface DoctorBootMarkerState {
  action: string;
  timestamp: number | null;
}

export interface DoctorWebState {
  enabled: boolean;
  port: string;
  tokenPresent: boolean;
}

export interface DoctorReport {
  version: string;
  nodeVersion: string;
  dataDir: string;
  dataDirExists: boolean;
  checks: DoctorCheck[];
  queue: DoctorQueueState | null;
  bootMarker: DoctorBootMarkerState | null;
  web: DoctorWebState;
  pluginIntegrity: PluginIntegrityResult[];
  /** Aggregate verdict for scripts; the human output does not print it. */
  ok: boolean;
}

/** Reads bot_data/retry_queue.json without booting the app (doctor must stay offline). */
export function readQueueStats(dataDir: string): DoctorQueueState | null {
  try {
    const file = path.join(dataDir, 'bot_data', 'retry_queue.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      tasks?: Array<{ status?: string }>;
    };
    const tasks = parsed.tasks ?? [];
    let dead = 0;
    for (const task of tasks) {
      if (task.status === 'dead') dead += 1;
    }
    return { pending: tasks.length - dead, dead };
  } catch {
    return null;
  }
}

/**
 * Collects everything `pkh doctor` reports as one plain object. Both the human output
 * and `--json` render from this, so the two can never drift apart. Nothing is booted:
 * StorageService only reads/writes the store files, and no plugin, web or Telegram
 * service is ever loaded.
 *
 * `pluginsDir` mirrors `--plugins-dir` / PKH_PLUGINS_DIR so the integrity check looks
 * where the bot actually loads plugins from, not always at <dataDir>/plugins.
 */
export async function buildDoctorReport(
  dataDir: string,
  options: { pluginsDir?: string } = {},
): Promise<DoctorReport> {
  const resolvedDataDir = path.resolve(dataDir);
  const pluginsDir =
    options.pluginsDir ?? process.env.PKH_PLUGINS_DIR ?? path.join(resolvedDataDir, 'plugins');
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: resolvedDataDir });

  try {
    const config = ctx.storage.getConfig();

    // Deliberately checked after StorageService was constructed: reading a store creates
    // bot_settings/, and the original doctor reported the same post-creation state.
    const dataDirExists = fs.existsSync(resolvedDataDir);

    const checks: DoctorCheck[] = [
      {
        id: 'node',
        label: 'Node.js >= 20',
        ok: Number(process.versions.node.split('.')[0]) >= 20,
        detail: process.version,
      },
      {
        id: 'data-dir',
        label: 'Каталог данных',
        ok: dataDirExists,
        detail: resolvedDataDir,
      },
      {
        id: 'telegram-token',
        label: 'Telegram Token',
        ok: isTgTokenValid(config.telegram.api.token),
        detail: config.telegram.api.token ? 'валидный формат' : 'не задан',
      },
      {
        id: 'playerok-cookies',
        label: 'PlayerOK Cookies',
        ok: isCookiesValid(config.playerok.api.cookies),
        detail: config.playerok.api.cookies
          ? 'валидный формат'
          : 'не заданы (используйте --dry-run для теста)',
      },
      {
        id: 'telegram-owners',
        label: 'Владельцы Telegram',
        ok: config.telegram.bot.signed_users.length > 0,
        detail: `авторизовано: ${config.telegram.bot.signed_users.length}`,
      },
    ];

    const marker = ctx.storage.get<BootMarker>('boot_marker');
    const bootMarker: DoctorBootMarkerState | null = marker?.action
      ? {
          action: marker.action,
          timestamp: typeof marker.timestamp === 'number' ? marker.timestamp : null,
        }
      : null;

    const queue = readQueueStats(resolvedDataDir);

    const webPort = process.env.PKH_WEB_PORT ?? '8787';
    const webEnabled = ['1', 'true', 'yes', 'on'].includes(
      (process.env.PKH_WEB_ENABLED ?? '').toLowerCase(),
    );
    const webTokenPresent = Boolean(process.env.PKH_WEB_TOKEN);

    // Read-only hash check: an offline `doctor` must see a tampered plugin file even
    // when the bot is not running.
    const pluginIntegrity = verifyPluginIntegrity({
      pluginsDir,
      manifestPath: pluginIntegrityManifestPath(resolvedDataDir),
    });

    const ok =
      checks.every((check) => check.ok) &&
      (queue === null || queue.dead === 0) &&
      bootMarker === null &&
      pluginIntegrity.every((result) => result.ok);

    return {
      version: VERSION,
      nodeVersion: process.version,
      dataDir: resolvedDataDir,
      dataDirExists,
      checks,
      queue,
      bootMarker,
      web: { enabled: webEnabled, port: webPort, tokenPresent: webTokenPresent },
      pluginIntegrity,
      ok,
    };
  } finally {
    await ctx.fiber.dispose();
  }
}
