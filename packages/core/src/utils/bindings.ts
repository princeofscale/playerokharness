import type { BindingEntry, BoundItem, ItemBinding } from '../schemas/settings.js';
import { escapeHtml } from './validators.js';

const ITEM_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ITEM_SLUG_RE = /^[^\s/\\]{1,200}$/;

export interface MatchableItem {
  id?: string | null;
  slug?: string | null;
  name?: string | null;
}

export function parseItemRef(text: string): { kind: 'id' | 'slug'; value: string } {
  let ref = (text || '').trim();
  if (!ref) {
    throw new Error('пустая строка');
  }

  if (ref.includes('/') || ref.toLowerCase().includes('playerok.com')) {
    const withProto = ref.includes('://') ? ref : `https://${ref}`;
    let parsed: URL;
    try {
      parsed = new URL(withProto);
    } catch {
      throw new Error('некорректный URL');
    }

    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) {
      host = host.slice(4);
    }
    if (host !== 'playerok.com') {
      throw new Error('ссылка не с playerok.com');
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || !['products', 'product'].includes(parts[parts.length - 2])) {
      throw new Error('в ссылке нет пути /products/');
    }
    ref = decodeURIComponent(parts[parts.length - 1]);
  }

  if (ITEM_UUID_RE.test(ref)) {
    return { kind: 'id', value: ref.toLowerCase() };
  }
  if (ITEM_SLUG_RE.test(ref)) {
    return { kind: 'slug', value: ref };
  }
  throw new Error('не похоже ни на ссылку, ни на slug, ни на ID');
}

export function normalizeBinding(entry: BindingEntry | unknown): ItemBinding {
  if (Array.isArray(entry)) {
    return { keyphrases: entry.map(String) };
  }
  if (entry && typeof entry === 'object') {
    return entry as ItemBinding;
  }
  return {};
}

export function bindingItems(entry: BindingEntry | unknown): BoundItem[] {
  const items = normalizeBinding(entry).items;
  if (!Array.isArray(items)) return [];
  return items.filter((it): it is BoundItem => Boolean(it && typeof it === 'object' && typeof it.id === 'string'));
}

export function bindingPhrases(entry: BindingEntry | unknown): string[] {
  const phrases = normalizeBinding(entry).keyphrases;
  if (!Array.isArray(phrases)) return [];
  return phrases.map(String).filter(Boolean);
}

export function itemMatchesBinding(item: MatchableItem, entry: BindingEntry | unknown): boolean {
  const itemId = item.id || undefined;
  const itemSlug = item.slug || undefined;

  for (const bound of bindingItems(entry)) {
    if (itemId && bound.id === itemId) return true;
    if (itemSlug && bound.slug && bound.slug === itemSlug) return true;
  }

  const name = (item.name || '').toLowerCase();
  if (name) {
    for (const phrase of bindingPhrases(entry)) {
      if (name.includes(phrase.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

export function itemMatchesAnyBinding(item: MatchableItem, entries: BindingEntry[] | undefined): boolean {
  if (!entries || entries.length === 0) return false;
  return entries.some((entry) => itemMatchesBinding(item, entry));
}

export function collectBindingIds(entries: BindingEntry[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries || []) {
    for (const bound of bindingItems(entry)) {
      if (bound.id) ids.add(bound.id);
    }
  }
  return ids;
}

export function splitNewItems(
  items: BoundItem[],
  entries: BindingEntry[],
): { fresh: BoundItem[]; dupes: string[] } {
  const existing = collectBindingIds(entries);
  const fresh: BoundItem[] = [];
  const dupes: string[] = [];

  for (const item of items) {
    if (existing.has(item.id)) {
      const name = item.name || item.slug || item.id;
      dupes.push(`${escapeHtml(name)} — уже добавлен`);
      continue;
    }
    fresh.push(item);
    existing.add(item.id);
  }
  return { fresh, dupes };
}

export function itemUrl(bound: Pick<BoundItem, 'slug'> | null | undefined): string | null {
  const slug = bound?.slug;
  if (!slug) return null;
  return `https://playerok.com/products/${encodeURIComponent(slug)}`;
}

export function bindingKey(entry: BindingEntry | unknown): string {
  const ids = bindingItems(entry)
    .map((b) => String(b.id || b.slug || ''))
    .sort();
  const phrases = bindingPhrases(entry)
    .map((p) => p.toLowerCase())
    .sort();
  return JSON.stringify([ids, phrases]);
}

export function bindingTitle(entry: BindingEntry | unknown, empty = '❌ Не указано'): string {
  const names = bindingItems(entry)
    .map((b) => (b.name || b.slug || b.id || '').trim())
    .filter(Boolean);
  if (names.length > 0) {
    return names.join(', ');
  }
  const phrases = bindingPhrases(entry);
  if (phrases.length > 0) {
    return `🔑 ${phrases.join(', ')}`;
  }
  return empty;
}

export function bindingLinks(entry: BindingEntry | unknown, empty = '❌ Не указано'): string {
  const parts: string[] = [];
  for (const bound of bindingItems(entry)) {
    const name = (bound.name || bound.slug || bound.id || '').trim();
    if (!name) continue;
    const url = itemUrl(bound);
    parts.push(url ? `<a href="${url}">${escapeHtml(name)}</a>` : escapeHtml(name));
  }
  if (parts.length > 0) return parts.join(', ');

  const phrases = bindingPhrases(entry);
  if (phrases.length > 0) {
    return `🔑 ${escapeHtml(phrases.join(', '))}`;
  }
  return empty;
}

/**
 * Recursively updates bound item references when an item is recreated with a new ID/slug.
 * Returns number of updated references.
 */
export function rebindInObject(obj: unknown, oldId: string, next: BoundItem): number {
  let changed = 0;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      changed += rebindInObject(item, oldId, next);
    }
    return changed;
  }
  if (obj && typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key === 'items' && Array.isArray(value)) {
        for (const bound of value) {
          if (bound && typeof bound === 'object' && (bound as Record<string, unknown>).id === oldId) {
            const target = bound as Record<string, unknown>;
            target.id = next.id;
            if (next.slug) target.slug = next.slug;
            if (next.name) target.name = next.name;
            changed += 1;
            continue;
          }
          changed += rebindInObject(bound, oldId, next);
        }
        continue;
      }
      changed += rebindInObject(value, oldId, next);
    }
  }
  return changed;
}
