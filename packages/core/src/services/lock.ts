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

    // O_EXCL create is the only atomic step here: checking existsSync() and then
    // writing let two processes starting at the same instant both "acquire" the lock.
    const tryCreate = (): boolean => {
      try {
        fs.writeFileSync(lockPath, String(process.pid), { encoding: 'utf8', flag: 'wx' });
        this.acquiredPaths.add(lockPath);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
        return false;
      }
    };

    if (tryCreate()) return null;

    let existingPid = 0;
    try {
      existingPid = Number(fs.readFileSync(lockPath, 'utf8').trim());
    } catch {
      // unreadable lock — treat as stale
    }
    if (existingPid !== process.pid && isPidAlive(existingPid)) {
      return existingPid;
    }

    // Stale lock owned by a dead PID: drop it and race for the file once.
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // ignore
    }
    if (tryCreate()) return null;

    try {
      const winner = Number(fs.readFileSync(lockPath, 'utf8').trim());
      return Number.isFinite(winner) && winner > 0 ? winner : process.pid;
    } catch {
      return process.pid;
    }
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
