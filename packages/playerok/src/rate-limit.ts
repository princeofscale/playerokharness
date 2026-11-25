/**
 * Dependency-free token bucket used to throttle every outbound PlayerOK request.
 *
 * PlayerOK publishes no rate limit, but a bot that hammers `/graphql` (parallel
 * polling loops, retry bursts, WS re-subscribe storms) gets anti-bot challenged.
 * The bucket turns "however fast the event loop fires" into a bounded request
 * rate and makes the pressure observable (`stats()`) instead of invisible.
 *
 * Properties relied on by the transport:
 * - `capacity` is the burst size; `capacity: 0` disables throttling completely
 *   (used by tests and by callers who do not want a client-side limit).
 * - `refillPerSecond` may be fractional: tokens accumulate as floats so a slow
 *   refill still yields a token at the right time.
 * - Waiters are served strictly FIFO: the queue is a plain array drained from
 *   the head, so a request never jumps ahead of an earlier one.
 * - A waiter that cannot obtain a token within `maxWaitMs` is rejected with
 *   `RateLimitTimeoutError` instead of hanging forever.
 * - `close()` rejects every waiter with `RateLimitClosedError` and clears the
 *   single pump timer, so a closed transport leaks neither promises nor timers.
 */

/** Default ceiling for a single `acquire()` call. */
export const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = 30_000;

/** Float tolerance: a token is only handed out when one is really available. */
const TOKEN_EPSILON = 1e-6;

/** Per-request limiter configuration (all fields optional at the call site). */
export interface RateLimitOptions {
  /** Burst size. `0` means unlimited: `acquire()` never waits. */
  capacity?: number;
  /** Sustained refill rate; fractional values are supported. */
  refillPerSecond?: number;
  /** How long `acquire()` may wait before rejecting. */
  maxWaitMs?: number;
}

export interface TokenBucketOptions extends RateLimitOptions {
  /** Burst size; required here (a bucket always has an explicit budget). */
  capacity: number;
  /** Sustained refill rate; required here. */
  refillPerSecond: number;
  /** Optional clock override (tests use it to check refill math deterministically). */
  now?: () => number;
  /** Name used in error messages and diagnostics. */
  name?: string;
}

export interface TokenBucketStats {
  /**
   * Tokens a new `acquire()` would find right now (fractional). An unlimited
   * bucket (capacity 0) reports `Number.POSITIVE_INFINITY`.
   */
  available: number;
  /** Callers waiting for a slot right now. */
  queued: number;
  /** Successful `acquire()` calls (immediate + eventually refilled). */
  acquired: number;
  /** `acquire()` calls that never got a token (max wait elapsed or bucket closed). */
  rejected: number;
}

interface TokenWaiter {
  deadline: number;
  waitMs: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** `acquire()` waited longer than `maxWaitMs`; no HTTP call was made. */
export class RateLimitTimeoutError extends Error {
  public readonly bucket: string;
  public readonly waitedMs: number;
  public readonly queued: number;

  constructor(bucket: string, waitedMs: number, queued: number) {
    super(
      `Лимит запросов PlayerOK (${bucket}): слот не освободился за ${Math.round(waitedMs)} мс, в очереди ${queued}. ` +
        'Увеличьте capacity/refillPerSecond или уменьшите параллелизм.',
    );
    this.name = 'RateLimitTimeoutError';
    this.bucket = bucket;
    this.waitedMs = waitedMs;
    this.queued = queued;
  }
}

/** The transport was closed while `acquire()` was waiting; no HTTP call was made. */
export class RateLimitClosedError extends Error {
  public readonly bucket: string;

  constructor(bucket: string) {
    super(`Транспорт PlayerOK закрыт: ожидающий слот лимита запросов (${bucket}) отменён`);
    this.name = 'RateLimitClosedError';
    this.bucket = bucket;
  }
}

/**
 * FIFO token bucket. One pump timer exists at most at any moment, and only
 * while somebody is actually queued; it is `unref()`ed so it never keeps the
 * process alive by itself.
 */
export class TokenBucket {
  private readonly capacityValue: number;
  private readonly refillPerSecondValue: number;
  private readonly maxWaitMs: number;
  private readonly bucketName: string;
  private readonly clock: () => number;

  private tokens: number;
  private lastRefillAt: number;
  private waiters: TokenWaiter[] = [];
  private pumpTimer: NodeJS.Timeout | null = null;
  private closedFlag = false;
  private acquiredCount = 0;
  private rejectedCount = 0;

  constructor(options: TokenBucketOptions) {
    if (!Number.isFinite(options.capacity) || options.capacity < 0) {
      throw new RangeError(`TokenBucket: capacity должен быть >= 0 (получено ${options.capacity})`);
    }
    if (!Number.isFinite(options.refillPerSecond) || options.refillPerSecond < 0) {
      throw new RangeError(
        `TokenBucket: refillPerSecond должен быть >= 0 (получено ${options.refillPerSecond})`,
      );
    }
    const maxWaitMs = options.maxWaitMs ?? DEFAULT_RATE_LIMIT_MAX_WAIT_MS;
    if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
      throw new RangeError(`TokenBucket: maxWaitMs должен быть >= 0 (получено ${maxWaitMs})`);
    }
    this.capacityValue = Math.floor(options.capacity);
    this.refillPerSecondValue = options.refillPerSecond;
    this.maxWaitMs = maxWaitMs;
    this.bucketName = options.name ?? 'token-bucket';
    this.clock = options.now ?? (() => Date.now());
    this.tokens = this.capacityValue;
    this.lastRefillAt = this.clock();
  }

  public get capacity(): number {
    return this.capacityValue;
  }

  public get refillPerSecond(): number {
    return this.refillPerSecondValue;
  }

  /** `true` when `capacity` is 0: no throttling and no queueing at all. */
  public get unlimited(): boolean {
    return this.capacityValue === 0;
  }

  public get closed(): boolean {
    return this.closedFlag;
  }

  /**
   * Waits for a token. Resolves as soon as one is available, rejects with
   * `RateLimitTimeoutError` after the (per-call or configured) max wait and
   * with `RateLimitClosedError` once the bucket is closed.
   */
  public acquire(maxWaitMs = this.maxWaitMs): Promise<void> {
    if (this.closedFlag) {
      return Promise.reject(new RateLimitClosedError(this.bucketName));
    }
    if (this.unlimited) {
      this.acquiredCount += 1;
      return Promise.resolve();
    }
    this.refill();
    if (this.waiters.length === 0 && this.tokens >= 1 - TOKEN_EPSILON) {
      this.tokens = Math.max(0, this.tokens - 1);
      this.acquiredCount += 1;
      return Promise.resolve();
    }
    const waitMs = Math.max(0, maxWaitMs);
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ deadline: this.clock() + waitMs, waitMs, resolve, reject });
      this.schedule();
    });
  }

  public stats(): TokenBucketStats {
    if (!this.closedFlag) this.refill();
    return {
      available: this.unlimited
        ? Number.POSITIVE_INFINITY
        : Math.round(this.tokens * 1e6) / 1e6,
      queued: this.waiters.length,
      acquired: this.acquiredCount,
      rejected: this.rejectedCount,
    };
  }

  /**
   * Rejects every waiter with `RateLimitClosedError` and clears the pump timer.
   * Idempotent; the bucket stays closed until `reopen()`.
   */
  public close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.clearPumpTimer();
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      this.rejectedCount += 1;
      waiter.reject(new RateLimitClosedError(this.bucketName));
    }
  }

  /** Re-arms a closed bucket (a re-subscribed transport must accept work again). */
  public reopen(): void {
    if (!this.closedFlag) return;
    this.closedFlag = false;
    this.lastRefillAt = this.clock();
    this.tokens = this.capacityValue;
  }

  private refill(): void {
    if (this.unlimited) return;
    const now = this.clock();
    const elapsedMs = now - this.lastRefillAt;
    if (elapsedMs <= 0) return;
    this.lastRefillAt = now;
    this.tokens = Math.min(
      this.capacityValue,
      this.tokens + (elapsedMs / 1000) * this.refillPerSecondValue,
    );
  }

  /** Hands tokens to the oldest waiters first. */
  private drain(): void {
    while (this.waiters.length > 0 && this.tokens >= 1 - TOKEN_EPSILON) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      this.tokens = Math.max(0, this.tokens - 1);
      this.acquiredCount += 1;
      waiter.resolve();
    }
  }

  /** Rejects the waiters whose max wait has elapsed (always from the head). */
  private expireWaiters(): void {
    const now = this.clock();
    while (this.waiters.length > 0) {
      const head = this.waiters[0];
      if (!head || head.deadline > now) break;
      this.waiters.shift();
      this.rejectedCount += 1;
      head.reject(new RateLimitTimeoutError(this.bucketName, head.waitMs, this.waiters.length));
    }
  }

  /**
   * Keeps exactly one timer armed while waiters exist: it fires at whichever
   * comes first - the next token or the head waiter's deadline.
   */
  private schedule(): void {
    this.clearPumpTimer();
    if (this.closedFlag) return;
    const head = this.waiters[0];
    if (!head) return;

    const now = this.clock();
    let delayMs: number;
    if (this.tokens >= 1 - TOKEN_EPSILON) {
      delayMs = 0;
    } else if (this.refillPerSecondValue > 0) {
      delayMs = ((1 - this.tokens) / this.refillPerSecondValue) * 1000;
    } else {
      delayMs = Number.POSITIVE_INFINITY;
    }
    delayMs = Math.min(delayMs, Math.max(0, head.deadline - now));

    const timer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, Math.max(1, Math.ceil(delayMs)));
    timer.unref?.();
    this.pumpTimer = timer;
  }

  private pump(): void {
    if (this.closedFlag) return;
    this.refill();
    this.expireWaiters();
    this.drain();
    if (this.waiters.length > 0) this.schedule();
  }

  private clearPumpTimer(): void {
    if (!this.pumpTimer) return;
    clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
  }
}
