import fs from 'node:fs';
import path from 'node:path';
import { Context, Service } from 'cordis';

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export class LockService extends Service {
  static provide = 'lock';
  static inject = ['storage'];

  private readonly acquiredPaths = new Set<string>();

  constructor(ctx: Context) {
    super(ctx, 'lock');

    ctx.effect(() => {
      return () => {
        this.releaseAll();
      };
    }, 'lock:cleanup');
  }

  private acquireFileLock(lockPath: string): number | null {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    if (fs.existsSync(lockPath)) {
      try {
        const existingPid = Number(fs.readFileSync(lockPath, 'utf8').trim());
        if (existingPid !== process.pid && isPidAlive(existingPid)) {
          return existingPid;
        }
      } catch {
        // stale or unreadable lock
      }
    }
    fs.writeFileSync(lockPath, String(process.pid), 'utf8');
    this.acquiredPaths.add(lockPath);
    return null;
  }

  public acquireInstanceLock(): number | null {
    return this.acquireFileLock(this.ctx.storage.resolvePath('bot_data/.instance.lock'));
  }

  public acquireAccountLock(accountId: string): number | null {
    const safeId = accountId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return this.acquireFileLock(this.ctx.storage.resolvePath(`bot_data/.account_${safeId}.lock`));
  }

  public releaseAll(): void {
    for (const lockPath of this.acquiredPaths) {
      try {
        if (fs.existsSync(lockPath)) {
          const content = Number(fs.readFileSync(lockPath, 'utf8').trim());
          if (content === process.pid) {
            fs.unlinkSync(lockPath);
          }
        }
      } catch {
        // ignore
      }
    }
    this.acquiredPaths.clear();
  }
}
