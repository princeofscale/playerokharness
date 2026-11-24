import crypto from 'node:crypto';
import { Context, Service } from 'cordis';
import type { AccessRequest, AccessRequests, OwnerLink } from '../schemas/settings.js';

export const REQUEST_COOLDOWN_SEC = 24 * 60 * 60;
export const OWNER_PREFIX = 'owner_';

export class AccessService extends Service {
  static provide = 'access';
  static inject = ['storage'];

  constructor(ctx: Context) {
    super(ctx, 'access');
  }

  public getSignedUsers(): number[] {
    return [...this.ctx.storage.getConfig().telegram.bot.signed_users];
  }

  public isSigned(userId: number): boolean {
    return this.getSignedUsers().includes(userId);
  }

  public addSignedUser(userId: number): boolean {
    let added = false;
    this.ctx.storage.updateConfig((cfg) => {
      if (!cfg.telegram.bot.signed_users.includes(userId)) {
        cfg.telegram.bot.signed_users.push(userId);
        added = true;
      }
    });
    if (added) {
      this.forgetRequest(userId);
      this.ctx.storage.set<OwnerLink>('owner_link', {});
    }
    return added;
  }

  public removeSignedUser(userId: number): boolean {
    let removed = false;
    this.ctx.storage.updateConfig((cfg) => {
      const idx = cfg.telegram.bot.signed_users.indexOf(userId);
      if (idx !== -1) {
        cfg.telegram.bot.signed_users.splice(idx, 1);
        removed = true;
      }
    });
    return removed;
  }

  public getOwnerCode(): string {
    const link = this.ctx.storage.get<OwnerLink>('owner_link');
    if (link.code) return link.code;
    const code = crypto.randomBytes(16).toString('base64url');
    this.ctx.storage.set<OwnerLink>('owner_link', { code });
    return code;
  }

  public getOwnerLink(botUsername: string): string {
    return `https://t.me/${botUsername}?start=${OWNER_PREFIX}${this.getOwnerCode()}`;
  }

  public claimOwner(userId: number, code: string): boolean {
    if (this.getSignedUsers().length > 0) return false;
    const link = this.ctx.storage.get<OwnerLink>('owner_link');
    if (!link.code || !code) return false;
    const a = Buffer.from(link.code, 'utf8');
    const b = Buffer.from(code, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return false;
    }
    this.ctx.storage.set<OwnerLink>('owner_link', {});
    this.addSignedUser(userId);
    return true;
  }

  public isLegacyPasswordLogin(): boolean {
    const cfg = this.ctx.storage.getConfig();
    return cfg.telegram.bot.signed_users.length === 0 && Boolean(cfg.telegram.bot.password);
  }

  public verifyPasswordLogin(userId: number, password: string): boolean {
    const cfg = this.ctx.storage.getConfig();
    const expected = cfg.telegram.bot.password;
    if (!expected || !password) return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(password, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return false;
    }
    this.addSignedUser(userId);
    return true;
  }

  private getActiveRequests(): AccessRequests {
    const nowSec = Math.floor(Date.now() / 1000);
    const all = this.ctx.storage.get<AccessRequests>('access_requests');
    const active: AccessRequests = {};
    for (const [key, req] of Object.entries(all)) {
      if (nowSec - req.time < REQUEST_COOLDOWN_SEC) {
        active[key] = req;
      }
    }
    return active;
  }

  public getRequest(userId: number): AccessRequest | null {
    return this.getActiveRequests()[String(userId)] ?? null;
  }

  public canRequestAccess(userId: number): boolean {
    return this.getRequest(userId) === null;
  }

  public rememberRequest(userId: number, username?: string | null, name?: string | null): void {
    const active = this.getActiveRequests();
    active[String(userId)] = {
      time: Math.floor(Date.now() / 1000),
      username: username ?? null,
      name: name ?? null,
    };
    this.ctx.storage.set<AccessRequests>('access_requests', active);
  }

  public forgetRequest(userId: number): void {
    const active = this.getActiveRequests();
    if (String(userId) in active) {
      delete active[String(userId)];
      this.ctx.storage.set<AccessRequests>('access_requests', active);
    }
  }
}
