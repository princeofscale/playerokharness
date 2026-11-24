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

function formatArgs(args: unknown[]): string {
  return args
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

    // Periodic log size guard matching clear_logs_task() in bot.py
    ctx.effect(() => {
      const timer = setInterval(() => this.enforceMaxFileSize(), 30_000);
      timer.unref?.();
      return () => clearInterval(timer);
    }, 'logSink:maxSizeGuard');
  }

  private handleMessage(message: Message): void {
    const ts = formatTimestamp(message.ts);
    const label = LEVEL_LABELS[message.type] ?? message.type.toUpperCase();
    const scope = message.name || 'universal';
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

  public enforceMaxFileSize(): void {
    try {
      if (!fs.existsSync(this.logFilePath)) return;
      const stats = fs.statSync(this.logFilePath);
      const sizeMb = stats.size / (1024 * 1024);
      const maxMb = this.ctx.storage.getConfig().logs.max_file_size;
      if (sizeMb > maxMb) {
        fs.writeFileSync(this.logFilePath, '', 'utf8');
      }
    } catch {
      // ignore
    }
  }

  public getRecentLines(limit = 50): string[] {
    try {
      if (!fs.existsSync(this.logFilePath)) return [];
      const content = fs.readFileSync(this.logFilePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      return lines.slice(-limit);
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
