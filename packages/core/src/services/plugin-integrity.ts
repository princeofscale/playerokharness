import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  PluginIntegrityEntry,
  PluginIntegrityResult,
  PluginIntegrityState,
} from '../types/models.js';
import { readJsonSafe, writeJsonAtomic } from './storage.js';

/** Manifest path relative to the data dir (bot_settings/, bot_data/, logs/, plugins/). */
export const PLUGIN_INTEGRITY_MANIFEST_PATH = 'bot_data/plugin_integrity.json';

export interface PluginIntegrityManifest {
  version: 1;
  plugins: Record<string, PluginIntegrityEntry>;
}

const PluginIntegrityEntrySchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  installedAt: z.string().min(1),
  file: z.string().min(1),
});

/**
 * The manifest is deliberately a plain JSON file rather than a registered store:
 * it describes files on disk, and reading it must never rewrite bot_settings.
 */
export const PluginIntegrityManifestSchema = z.object({
  version: z.literal(1).default(1),
  plugins: z.record(z.string(), PluginIntegrityEntrySchema).default({}),
});

const emptyManifest = (): PluginIntegrityManifest => ({ version: 1, plugins: {} });

/** Absolute manifest path for a data dir; matches StorageService resolvePath(). */
export function pluginIntegrityManifestPath(dataDir: string): string {
  return path.resolve(dataDir, PLUGIN_INTEGRITY_MANIFEST_PATH);
}

export function hashPluginFile(filePath: string): { sha256: string; size: number } {
  const buffer = fs.readFileSync(filePath);
  return {
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    size: buffer.byteLength,
  };
}

export function readPluginIntegrityManifest(manifestPath: string): PluginIntegrityManifest {
  return readJsonSafe<PluginIntegrityManifest>(
    manifestPath,
    PluginIntegrityManifestSchema as unknown as z.ZodType<PluginIntegrityManifest>,
    emptyManifest,
    false,
  );
}

export function writePluginIntegrityManifest(
  manifestPath: string,
  manifest: PluginIntegrityManifest,
): void {
  writeJsonAtomic(manifestPath, manifest);
}

/**
 * Pins (or re-pins) the hash of an installed plugin file. Only explicit installs
 * call this: an already-pinned plugin that changes on disk must stay a mismatch
 * instead of being silently re-blessed.
 */
export function recordPluginIntegrity(
  manifestPath: string,
  id: string,
  filePath: string,
): PluginIntegrityEntry {
  const digest = hashPluginFile(filePath);
  const manifest = readPluginIntegrityManifest(manifestPath);
  const entry: PluginIntegrityEntry = {
    sha256: digest.sha256,
    size: digest.size,
    installedAt: new Date().toISOString(),
    file: path.resolve(filePath),
  };
  manifest.plugins[id] = entry;
  writePluginIntegrityManifest(manifestPath, manifest);
  return entry;
}

/**
 * Pins a hash only when the plugin has none yet (first discovery of a file that
 * was copied into plugins/ by hand). An existing pin is never overwritten here.
 */
export function baselinePluginIntegrity(
  manifestPath: string,
  id: string,
  filePath: string,
): PluginIntegrityEntry | null {
  const manifest = readPluginIntegrityManifest(manifestPath);
  if (manifest.plugins[id]) return null;
  return recordPluginIntegrity(manifestPath, id, filePath);
}

export function forgetPluginIntegrity(manifestPath: string, id: string): boolean {
  const manifest = readPluginIntegrityManifest(manifestPath);
  if (!Object.prototype.hasOwnProperty.call(manifest.plugins, id)) return false;
  delete manifest.plugins[id];
  writePluginIntegrityManifest(manifestPath, manifest);
  return true;
}

/**
 * Plugin entry files on disk, using the same rules as PluginManagerService
 * discovery: a .mjs/.js file, or a directory with index.mjs/index.js.
 */
export function scanPluginEntryFiles(pluginsDir: string): Map<string, string> {
  const found = new Map<string, string>();
  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const dirent of dirEntries) {
    if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
    if (dirent.isDirectory()) {
      for (const candidate of ['index.mjs', 'index.js']) {
        const full = path.join(pluginsDir, dirent.name, candidate);
        if (fs.existsSync(full)) {
          found.set(dirent.name, full);
          break;
        }
      }
    } else if (dirent.isFile() && /\.(mjs|js)$/.test(dirent.name)) {
      found.set(dirent.name.replace(/\.(mjs|js)$/, ''), path.join(pluginsDir, dirent.name));
    }
  }
  return found;
}

export interface PluginIntegrityOptions {
  pluginsDir: string;
  manifestPath: string;
}

/**
 * Recomputes every pinned hash on disk and reports files that were never pinned.
 * Read-only: it never writes the manifest, so it is safe to call from an offline
 * CLI (pkh doctor --json) as well as from PluginManagerService.
 */
export function verifyPluginIntegrity(opts: PluginIntegrityOptions): PluginIntegrityResult[] {
  const manifest = readPluginIntegrityManifest(opts.manifestPath);
  const onDisk = scanPluginEntryFiles(opts.pluginsDir);

  const ids = new Set<string>([...Object.keys(manifest.plugins), ...onDisk.keys()]);
  const results: PluginIntegrityResult[] = [];

  for (const id of Array.from(ids).sort()) {
    const entry: PluginIntegrityEntry | undefined = manifest.plugins[id];
    // Prefer the file discovery finds (the data dir may have been moved); fall
    // back to the recorded absolute path so a plugin that vanished is "missing".
    const file =
      onDisk.get(id) ?? (entry && fs.existsSync(entry.file) ? entry.file : undefined);

    let actual: string | null = null;
    let size: number | undefined;
    if (file) {
      try {
        const digest = hashPluginFile(file);
        actual = digest.sha256;
        size = digest.size;
      } catch {
        actual = null;
      }
    }

    let state: PluginIntegrityState;
    if (!entry) state = 'unknown';
    else if (!actual) state = 'missing';
    else state = entry.sha256 === actual ? 'ok' : 'mismatch';

    results.push({
      id,
      expected: entry?.sha256 ?? null,
      actual,
      ok: state === 'ok',
      state,
      path: file,
      size,
      installedAt: entry?.installedAt,
    });
  }

  return results;
}
