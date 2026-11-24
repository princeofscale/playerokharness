import { Context, Service } from 'cordis';
import type { BootMarker } from '../schemas/settings.js';
import type { BootError, LoadedPluginRecord } from '../types/models.js';
import { escapeHtml } from '../utils/validators.js';

const MARKER_TTL_MS = 15 * 60 * 1000;

export function explainBootError(trace: string): string {
  const lines = (trace || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? '';

  if (/Cannot find package '([^']+)'|Cannot find module '([^']+)'/.test(last)) {
    const match = last.match(/Cannot find (?:package|module) '([^']+)'/);
    return `Не установлен пакет <b>${escapeHtml(match?.[1] ?? 'unknown')}</b>, необходимый плагину`;
  }
  if (/SyntaxError/i.test(last)) {
    return 'В файле плагина синтаксическая ошибка — переустановите файл плагина';
  }
  if (/EACCES|EPERM/i.test(last)) {
    return 'Нет прав на доступ к файлам бота — проверьте права на каталог';
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|fetch failed/i.test(last)) {
    return 'Сетевая ошибка — проверьте интернет-соединение и настройки прокси';
  }
  return escapeHtml(last.slice(0, 300)) || 'Неизвестная ошибка';
}

export class BootReportService extends Service {
  static provide = 'bootReport';
  static inject = ['storage'];

  public bootId: number = Math.floor(Date.now() / 1000) % 100_000;
  public readonly startedAt: number = Date.now();

  private errors: BootError[] = [];
  private notes: string[] = [];

  constructor(ctx: Context) {
    super(ctx, 'bootReport');
  }

  public reset(): void {
    this.errors = [];
    this.notes = [];
    this.bootId = Math.floor(Date.now() / 1000) % 100_000;
  }

  public addError(module: string, stage: BootError['stage'], trace: string, text?: string): void {
    const summary = text || explainBootError(trace);
    const exists = this.errors.some(
      (e) => e.module === module && e.stage === stage && e.text === summary,
    );
    if (!exists) {
      this.errors.push({ module, stage, text: summary, trace });
    }
  }

  public addNote(note: string): void {
    if (!this.notes.includes(note)) {
      this.notes.push(note);
    }
  }

  public getErrors(): BootError[] {
    return [...this.errors];
  }

  public getNotes(): string[] {
    return [...this.notes];
  }

  public setMarker(action: string, chatId?: number | string, messageId?: number | null): void {
    this.ctx.storage.set<BootMarker>('boot_marker', {
      action,
      chat_id: chatId,
      message_id: messageId ?? null,
      timestamp: Date.now(),
    });
  }

  public popMarker(): BootMarker | null {
    const marker = this.ctx.storage.get<BootMarker>('boot_marker');
    if (marker && Object.keys(marker).length > 0) {
      this.ctx.storage.set<BootMarker>('boot_marker', {});
    }
    if (!marker?.timestamp || Date.now() - marker.timestamp >= MARKER_TTL_MS) {
      return null;
    }
    return marker;
  }

  public formatReportHtml(marker: BootMarker | null, plugins: LoadedPluginRecord[]): string {
    const enabledCount = plugins.filter((p) => p.enabled).length;
    const erroredPlugins = plugins.filter((p) => p.error);
    const allErrors = [...this.errors];
    for (const p of erroredPlugins) {
      if (!allErrors.some((e) => e.module === p.id)) {
        allErrors.push({
          module: p.id,
          stage: 'load',
          text: explainBootError(p.error || ''),
          trace: p.error || '',
        });
      }
    }

    const heading =
      marker?.action === 'restart'
        ? '🔄️ <b>Бот успешно перезапущен</b>'
        : marker?.action === 'setup'
          ? '🚀 <b>Бот запущен после настройки</b>'
          : '✅ <b>Бот запущен</b>';

    const lines = [
      heading,
      '',
      `🔌 Активных плагинов: <b>${enabledCount}/${plugins.length}</b>`,
    ];

    if (allErrors.length > 0) {
      lines.push('', `⚠️ <b>Ошибки при запуске (${allErrors.length}):</b>`);
      for (const err of allErrors.slice(0, 10)) {
        lines.push(`• <code>${escapeHtml(err.module)}</code> (${err.stage}): ${err.text}`);
      }
    }

    if (this.notes.length > 0) {
      lines.push('', ...this.notes.map((n) => `ℹ️ ${n}`));
    }

    return lines.join('\n');
  }
}
