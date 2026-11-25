import { createHash } from 'node:crypto';

/**
 * Hard Bot API limit for a single inline button payload, counted in UTF-8 bytes.
 * Anything above it is rejected at send time with BUTTON_DATA_INVALID, so the whole
 * keyboard disappears from the chat.
 */
export const CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Budget for the human-readable literal payload, leaving headroom under the hard limit
 * (the Bot API counts bytes, not characters, and values are usually Cyrillic).
 */
export const CALLBACK_LITERAL_MAX_BYTES = 60;

/** Upper bound on the in-memory callback registry (oldest entries are evicted first). */
export const CALLBACK_REGISTRY_LIMIT = 500;

/** Deterministic answer for a button whose stored payload is no longer known. */
export const STALE_CALLBACK_TEXT = 'кнопка устарела, откройте меню заново';

/**
 * A stored token is a single callback segment that always starts with '~', so the
 * dispatcher can tell it apart from a short human-readable value without asking the map.
 */
const TOKEN_MARKER = '~';
const TOKEN_PATTERN = /^~[A-Za-z0-9_-]{8}$/;

/**
 * Process-lifetime registry: '<prefix>:<hash>' -> original value.
 *
 * Inline buttons outlive the process (old messages stay in chat history), so the map is
 * deliberately not persisted — an unknown token is answered with STALE_CALLBACK_TEXT.
 */
const registry = new Map<string, string>();

function digest(value: string): string {
  return createHash('sha1').update(value, 'utf8').digest('base64url').slice(0, 8);
}

/** True when 'data' fits the Telegram Bot API 'callback_data' limit. */
export function callbackDataFits(data: string): boolean {
  return Buffer.byteLength(data, 'utf8') <= CALLBACK_DATA_MAX_BYTES;
}

/** True when a callback segment is a registry token rather than a literal value. */
export function isStoredCallbackKey(key: string): boolean {
  return TOKEN_PATTERN.test(key);
}

/**
 * Single entry point for every dynamic callback payload. Keeps the readable literal
 * ('<prefix>:<value>') as long as it fits the byte budget, and only falls back to a stored
 * token when the raw value would overflow the Bot API limit.
 */
export function fitCallback(prefix: string, value: string): string {
  const literal = value === '' ? prefix : prefix + ':' + value;
  if (Buffer.byteLength(literal, 'utf8') <= CALLBACK_LITERAL_MAX_BYTES) return literal;
  return storeCallback(prefix, value);
}

/**
 * Registers a free-form value and returns a short, stable token
 * ('<prefix>:~<8-char sha1 base64url>'). Stable means the same prefix+value pair always
 * yields the same payload, so re-rendered keyboards reuse one registry entry.
 */
export function storeCallback(prefix: string, value: string): string {
  const hash = digest(value);
  const mapKey = prefix + ':' + hash;
  // Re-insert to mark the entry as freshly used before the capacity trim below.
  if (registry.has(mapKey)) registry.delete(mapKey);
  registry.set(mapKey, value);
  while (registry.size > CALLBACK_REGISTRY_LIMIT) {
    const oldest = registry.keys().next();
    if (oldest.done) break;
    registry.delete(oldest.value);
  }
  return prefix + ':' + TOKEN_MARKER + hash;
}

/**
 * Resolves a stored token back to the value registered by storeCallback, or null when the
 * token was never registered / has been evicted / belongs to another prefix.
 * A leading '~' marker is optional, so both the returned payload and the bare hash work.
 */
export function resolveCallback(prefix: string, key: string): string | null {
  const normalized = key.startsWith(TOKEN_MARKER) ? key.slice(1) : key;
  return registry.get(prefix + ':' + normalized) ?? null;
}

/**
 * What the dispatcher does with one dynamic segment: a literal value is returned as-is,
 * a token is decoded, and an unknown token returns null (the caller answers "кнопка устарела").
 */
export function readCallbackValue(prefix: string, key: string): string | null {
  if (!isStoredCallbackKey(key)) return key;
  return resolveCallback(prefix, key);
}

/** Current number of registered values (introspection for tests and diagnostics). */
export function callbackRegistrySize(): number {
  return registry.size;
}
