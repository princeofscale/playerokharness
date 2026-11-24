import type { Context } from 'cordis';

export type CleanupFn = () => void | Promise<void>;

/**
 * Runs an async initialization task and binds its cleanup callback to the Cordis Context lifecycle.
 * Unlike un-awaited `ctx.effect(async () => ...)`, rejections are always logged AND rethrown
 * so initialization failures can never be silently swallowed.
 */
export async function safeEffect(
  ctx: Context,
  init: () => Promise<CleanupFn | void> | CleanupFn | void,
  label = 'safeEffect',
): Promise<() => Promise<void>> {
  const log = ctx.logger('effect');
  let cleanup: CleanupFn | void;

  try {
    cleanup = await init();
  } catch (err) {
    log.error(`Ошибка инициализации эффекта «${label}»: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  return ctx.effect(() => {
    return async () => {
      if (typeof cleanup === 'function') {
        try {
          await cleanup();
        } catch (err) {
          log.error(`Ошибка очистки эффекта «${label}»: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
  }, label);
}

/**
 * Registers a periodic async/sync task under Cordis lifecycle control with automatic error catching
 * and guaranteed `clearInterval` on plugin disposal.
 */
export interface SafeIntervalOptions {
  /**
   * Skip a tick while the previous run of the same task is still in flight.
   * Enabled by default: every current caller is a poll loop whose task can outlast
   * the interval (network calls with a 30s timeout behind a 3-5s timer), and
   * overlapping runs re-execute the same side effect (double bump, double send).
   */
  skipIfRunning?: boolean;
}

export function safeInterval(
  ctx: Context,
  task: () => void | Promise<void>,
  intervalMs: number,
  label = 'safeInterval',
  options: SafeIntervalOptions = {},
): () => Promise<void> {
  const log = ctx.logger('timer');
  const skipIfRunning = options.skipIfRunning !== false;
  let running = false;

  return ctx.effect(() => {
    const timer = setInterval(() => {
      if (skipIfRunning && running) {
        log.debug(`Таймер «${label}»: предыдущий проход ещё выполняется — тик пропущен`);
        return;
      }
      running = true;
      Promise.resolve()
        .then(() => task())
        .catch((err) => {
          log.error(`Ошибка в таймере «${label}»: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }, label);
}
