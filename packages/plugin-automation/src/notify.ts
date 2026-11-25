import type { Context, NotificationPayload } from '@pkh/core';

/**
 * Emits an operator notification without letting a failed delivery abort the automation step
 * that produced it.
 *
 * Every call site is a `catch` handler ("the bump/restore/withdrawal failed, tell the
 * operator"), and `ctx.parallel` rejects as soon as one listener throws: a dead Telegram
 * session used to turn a logged failure into a thrown one, which aborted the rest of the
 * `bumpItems`/`restoreExpiredItems` loop and silently skipped the remaining items.
 */
type AnnouncementEvent = 'item/restored' | 'item/bumped' | 'withdrawal/requested';

/**
 * Emits a *success* announcement ("the item was restored / bumped / the withdrawal was
 * created") without letting a broken listener flip the operation into a failure.
 *
 * All call sites sit inside the `try` that decides the outcome, so a throwing listener used
 * to run the `catch` below it: a completed withdrawal was reported as failed (with an error
 * notification) and a completed bump made `bumpItems()` count nothing.
 */
export async function announceSafely(
  ctx: Context,
  event: AnnouncementEvent,
  payload: unknown,
): Promise<void> {
  try {
    // Every announcement event takes exactly one payload; the per-event payload types differ,
    // so the narrowing happens here instead of casting at each call site.
    await (ctx.parallel as unknown as (name: string, ...args: unknown[]) => Promise<void>)(
      event,
      payload,
    );
  } catch (err) {
    ctx
      .logger('automation.announce')
      .error(
        `Обработчик события «${event}» завершился ошибкой: ${err instanceof Error ? err.message : String(err)}`,
      );
  }
}

export async function notifySafely(ctx: Context, payload: NotificationPayload): Promise<void> {
  try {
    await ctx.parallel('notify/log', payload);
  } catch (err) {
    ctx
      .logger('automation.notify')
      .error(
        `Не удалось отправить уведомление «${payload.eventKey ?? 'unknown'}»: ${err instanceof Error ? err.message : String(err)}`,
      );
  }
}
