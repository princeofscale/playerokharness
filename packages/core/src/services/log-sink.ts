import fs from 'node:fs';
import path from 'node:path';
import { Context, Service, type Message } from 'cordis';
import type { StorageService } from './storage.js';

export interface LogSinkConfig {
  silentConsole?: boolean;
  logFileRelativePath?: string;
}

const LEVEL_LABELS: Record<string, string> = {
  error: 'ERROR',
  warn: 'WARN ',
  info: 'INFO ',
  debug: 'DEBUG',
};

const LEVEL_COLORS: Record<string, string> = {
  error: '\x1b[91m',
  warn: '\x1b[93m',
  info: '\x1b[96m',
  debug: '\x1b[90m',
};
const RESET = '\x1b[0m';

/**
 * Redacts Telegram bot tokens, session cookies, Bearer tokens, and inline passwords
 * so secrets are never written to console output or log files.
 */
const SECRET_KEY = '(?:token|__ddg5_|session|password|cookies?|authorization)';

// Quoted / JSON position: {"cookies":"token=abc; __ddg5_=xyz"}. The bare key=value rule
// below cannot match it (the value starts with a quote), so cookies in object positions
// used to reach the log file verbatim.
const QUOTED_DOUBLE_RE = new RegExp(
  `("?\\b${SECRET_KEY}"?\\s*[:=]\\s*)"(?:[^"\\\\\\n]|\\\\.)*"`,
  'gi',
);
const QUOTED_SINGLE_RE = new RegExp(
  `(\\b${SECRET_KEY}\\s*[:=]\\s*)'(?:[^'\\\\\\n]|\\\\.)*'`,
  'gi',
);
const BARE_SECRET_RE = new RegExp(`(\\b${SECRET_KEY}\\s*[:=]\\s*)([^\\s;,"'}]+)`, 'gi');

export function redactSecrets(input: string): string {
  return input
    .replace(/\b\d{7,12}:[A-Za-z0-9_-]{35}\b/g, '[REDACTED_TG_TOKEN]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(QUOTED_DOUBLE_RE, '$1"[REDACTED]"')
    .replace(QUOTED_SINGLE_RE, "$1'[REDACTED]'")
    .replace(BARE_SECRET_RE, '$1[REDACTED]');
}

function formatArgs(args: unknown[]): string {
  const raw = args
    .map((arg) => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
  return redactSecrets(raw);
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class LogSinkService extends Service {
  static provide = 'logSink';
  static inject = ['storage'];

  public readonly logFilePath: string;
  private readonly silentConsole: boolean;

  constructor(ctx: Context, config: LogSinkConfig = {}) {
    super(ctx, 'logSink');
    const storage = ctx.storage as StorageService;
    this.logFilePath = storage.resolvePath(config.logFileRelativePath ?? 'logs/latest.log');
    this.silentConsole = Boolean(config.silentConsole);
    fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });

    ctx.logger.exporter({
      colors: false,
      export: (message: Message) => {
        this.handleMessage(message);
      },
    });

    ctx.effect(() => {
      const timer = setInterval(() => this.enforceMaxFileSize(), 30_000);
      timer.unref?.();
      return () => clearInterval(timer);
    }, 'logSink:maxSizeGuard');
  }

  private handleMessage(message: Message): void {
    const ts = formatTimestamp(message.ts);
    const label = LEVEL_LABELS[message.type] ?? message.type.toUpperCase();
    const scope = message.name || 'pkh';
    const text = formatArgs(message.args);

    const plainLine = `[${ts}] [${label}] [${scope}] ${text}`;

    if (!this.silentConsole) {
      const color = LEVEL_COLORS[message.type] ?? '';
      const coloredLine = `\x1b[90m[${ts}]${RESET} ${color}[${label}]${RESET} \x1b[37m[${scope}]${RESET} ${text}`;
      if (message.type === 'error') {
        console.error(coloredLine);
      } else if (message.type === 'warn') {
        console.warn(coloredLine);
      } else {
        console.log(coloredLine);
      }
    }

    try {
      fs.appendFileSync(this.logFilePath, `${plainLine}\n`, 'utf8');
    } catch {
      // avoid recursive logging on fs failure
    }
  }

  /** Number of rotated files kept next to the live log (latest.log.1, latest.log.2). */
  public static readonly ARCHIVES = 2;

  public enforceMaxFileSize(): void {
    try {
      if (!fs.existsSync(this.logFilePath)) return;
      const stats = fs.statSync(this.logFilePath);
      const sizeMb = stats.size / (1024 * 1024);
      const maxMb = this.ctx.storage.getConfig().logs.max_file_size;
      if (sizeMb > maxMb) this.rotate();
    } catch {
      // ignore
    }
  }

  /**
   * Rotates latest.log -> latest.log.1 (shifting older archives) instead of truncating.
   * The old behaviour destroyed the whole log right before the moment an operator
   * needs it — the crash evidence was deleted by the cleanup itself.
   */
  public rotate(): void {
    try {
      for (let index = LogSinkService.ARCHIVES; index >= 1; index -= 1) {
        const source = index === 1 ? this.logFilePath : `${this.logFilePath}.${index - 1}`;
        const target = `${this.logFilePath}.${index}`;
        if (!fs.existsSync(source)) continue;
        fs.renameSync(source, target);
      }
      fs.writeFileSync(this.logFilePath, '', 'utf8');
    } catch {
      // ignore
    }
  }

  public getRecentLines(limit = 50): string[] {
    return this.readTailLines(limit).slice(-limit);
  }

  /**
   * Reads only the tail of the log instead of the whole file: the size guard allows
   * multi-megabyte logs, and the Telegram panel asks for 40 lines on every refresh.
   */
  private readTailLines(limit: number): string[] {
    const maxTailBytes = Math.max(64 * 1024, limit * 512);
    try {
      if (!fs.existsSync(this.logFilePath)) return [];
      const fd = fs.openSync(this.logFilePath, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - maxTailBytes);
        const length = size - start;
        if (length <= 0) return [];
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        const text = buffer.toString('utf8');
        const lines = text.split('\n');
        // Drop a possibly half-read first line when the tail did not start at offset 0.
        if (start > 0) lines.shift();
        return lines.filter(Boolean);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  }

  public clearLogs(): void {
    try {
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
      fs.writeFileSync(this.logFilePath, '', 'utf8');
    } catch {
      // ignore
    }
  }
}
