import { Context, Service } from 'cordis';
import type { BlacklistEntry, BlacklistSettings } from '../schemas/settings.js';

export interface BlacklistEntryWithUser extends BlacklistEntry {
  username: string;
}

export class BlacklistService extends Service {
  static provide = 'blacklist';
  static inject = ['storage'];

  private readonly log;

  constructor(ctx: Context) {
    super(ctx, 'blacklist');
    this.log = ctx.logger('blacklist');
  }

  private findKey(users: Record<string, BlacklistEntry>, username?: string | null): string | null {
    if (!username) return null;
    const target = username.trim().replace(/^@+/, '').toLowerCase();
    if (!target) return null;
    for (const key of Object.keys(users)) {
      if (key.toLowerCase() === target) return key;
    }
    return null;
  }

  public list(): BlacklistEntryWithUser[] {
    const users = this.ctx.storage.getBlacklist().users;
    return Object.entries(users).map(([username, entry]) => ({
      username,
      ...entry,
    }));
  }

  public getEntry(username?: string | null): BlacklistEntryWithUser | null {
    const users = this.ctx.storage.getBlacklist().users;
    const key = this.findKey(users, username);
    if (!key) return null;
    return { username: key, ...users[key] };
  }

  public isBlacklisted(username?: string | null): boolean {
    return this.getEntry(username) !== null;
  }

  public add(username: string, reason = '', by = 'вручную'): boolean {
    const clean = username.trim().replace(/^@+/, '');
    if (!clean) return false;

    const bl = this.ctx.storage.getBlacklist();
    if (this.findKey(bl.users, clean)) return false;

    bl.users[clean] = {
      reason: reason.trim(),
      date: new Date().toISOString(),
      by,
    };
    this.ctx.storage.set<BlacklistSettings>('blacklist', bl);
    this.log.info(`Покупатель ${clean} добавлен в чёрный список (${by})${reason.trim() ? `: ${reason.trim()}` : ''}`);
    return true;
  }

  public remove(username: string): boolean {
    const bl = this.ctx.storage.getBlacklist();
    const key = this.findKey(bl.users, username);
    if (!key) return false;

    delete bl.users[key];
    this.ctx.storage.set<BlacklistSettings>('blacklist', bl);
    this.log.info(`Покупатель ${key} убран из чёрного списка`);
    return true;
  }
}
