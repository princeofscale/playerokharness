/**
 * In-memory rate limiter for the legacy admin-password login (`auth_password`).
 *
 * The password is a single shared secret with no per-user lockout in AccessService, so a
 * chat user could brute-force it. This limiter keeps a sliding window per Telegram user id:
 * after PASSWORD_MAX_ATTEMPTS failures inside PASSWORD_WINDOW_MS the user is blocked until
 * the oldest failure leaves the window. Nothing is persisted — a restart clears the counters,
 * which matches the threat model (an attacker cannot restart the bot).
 */
export const PASSWORD_MAX_ATTEMPTS = 5;
export const PASSWORD_WINDOW_MS = 10 * 60 * 1000;

export interface PasswordAttemptLimiterOptions {
  maxAttempts?: number;
  windowMs?: number;
  /** Injectable clock so tests do not depend on real time. */
  now?: () => number;
}

export class PasswordAttemptLimiter {
  private readonly attempts = new Map<number, number[]>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: PasswordAttemptLimiterOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? PASSWORD_MAX_ATTEMPTS;
    this.windowMs = options.windowMs ?? PASSWORD_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  /** Failed attempts still inside the current window. */
  public failures(userId: number): number {
    return this.recent(userId).length;
  }

  /** Attempts the user may still make before the window resets. */
  public remainingAttempts(userId: number): number {
    return Math.max(0, this.maxAttempts - this.failures(userId));
  }

  /** True when the next attempt must be rejected without checking the password. */
  public isBlocked(userId: number): boolean {
    return this.failures(userId) >= this.maxAttempts;
  }

  /** Seconds until the oldest failure leaves the window (0 when not blocked). */
  public retryAfterSec(userId: number): number {
    const oldest = this.recent(userId)[0];
    if (oldest === undefined) return 0;
    return Math.max(0, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }

  /** Records a wrong password and returns the number of failures in the window. */
  public recordFailure(userId: number): number {
    const recent = this.recent(userId);
    recent.push(this.now());
    this.attempts.set(userId, recent);
    return recent.length;
  }

  /** Clears the counters for a user (successful login). */
  public reset(userId: number): void {
    this.attempts.delete(userId);
  }

  private recent(userId: number): number[] {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.attempts.get(userId) ?? []).filter((ts) => ts > cutoff);
    if (recent.length === 0) this.attempts.delete(userId);
    else this.attempts.set(userId, recent);
    return recent;
  }
}
