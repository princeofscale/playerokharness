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
export function safeInterval(
  ctx: Context,
  task: () => void | Promise<void>,
  intervalMs: number,
  label = 'safeInterval',
): () => Promise<void> {
  const log = ctx.logger('timer');
  return ctx.effect(() => {
    const timer = setInterval(() => {
      Promise.resolve()
        .then(() => task())
        .catch((err) => {
          log.error(`Ошибка в таймере «${label}»: ${err instanceof Error ? err.message : String(err)}`);
        });
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }, label);
}
