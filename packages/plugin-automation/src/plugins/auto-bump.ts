import {
  Context,
  getCurrentBumpInterval,
  getCurrentBumpPosition,
  isDue,
  itemMatchesAnyBinding,
  ItemStatuses,
  PriorityTypes,
  safeInterval,
  Service,
  type BumpedItems,
  type ItemProfile,
  type MyItem,
} from '@pkh/core';
import '@pkh/adapter';
import '@pkh/plugin-retry-queue';
import { announceSafely, notifySafely } from '../notify.js';
import { auditOnce } from '../audit.js';

export interface TrackedPosition {
  name: string;
  slug: string;
  position: number;
  streak: number;
  checkedAt: string;
}

export interface AutoBumpConfig {
  tickIntervalMs?: number;
  enableTimer?: boolean;
}

export class AutoBumpService extends Service {
  static provide = 'autoBump';
  static inject = ['storage', 'playerok'];

  public readonly itemPositions = new Map<string, TrackedPosition>();
  private readonly log;

  constructor(ctx: Context, config: AutoBumpConfig = {}) {
    super(ctx, 'autoBump');
    this.log = ctx.logger('automation.bump');

    if (config.enableTimer !== false) {
      const tickMs = config.tickIntervalMs ?? 3_000;
      // safeInterval логирует и гасит reject из tick(): раньше сбой сети в getMyItems
      // уходил в unhandledRejection и (Node >= 15) ронял весь процесс.
      safeInterval(ctx, () => this.tick(), tickMs, 'autoBump:timer');
    }
  }

  public isBumpItemMatched(item: ItemProfile | MyItem): boolean {
    const cfg = this.ctx.storage.getConfig().playerok.auto_bump_items;
    const lists = this.ctx.storage.getAutoBumpItems();
    const included = itemMatchesAnyBinding(item, lists.included);
    const excluded = itemMatchesAnyBinding(item, lists.excluded);
    return (cfg.all && !excluded) || (!cfg.all && included);
  }

  public async tick(now: Date = new Date()): Promise<void> {
    const cfg = this.ctx.storage.getConfig();
    const bump = cfg.playerok.auto_bump_items;
    if (!bump.enabled) return;

    if (bump.mode === 'position') {
      const threshold = getCurrentBumpPosition(cfg, now);
      if (threshold > 0 && isDue(bump.last_check_time, bump.check_interval || 120, now)) {
        await this.checkItemsPositions(now);
      }
    } else {
      const interval = getCurrentBumpInterval(cfg, now);
      if (interval > 0 && isDue(bump.last_time, interval, now)) {
        await this.bumpItems(now);
      }
    }
  }

  public async bumpItem(itemOrProfile: ItemProfile | MyItem, reason?: string): Promise<boolean> {
    if (!this.isBumpItemMatched(itemOrProfile)) return false;

    try {
      const item: MyItem =
        'mayBePublished' in itemOrProfile
          ? itemOrProfile
          : await this.ctx.playerok.getItem({ id: itemOrProfile.id });

      const statuses = await this.ctx.playerok.getItemPriorityStatuses(item.id, item.rawPrice);
      const prem = statuses.find((s) => s.type === PriorityTypes.PREMIUM || s.price > 0);
      if (!prem) throw new Error('PREMIUM статус не найден');

      try {
        await this.ctx.playerok.increaseItemPriorityStatus(item.id, prem.id);
      } catch (bumpErr) {
        const msg = bumpErr instanceof Error ? bumpErr.message : String(bumpErr);
        const retryQueue = this.ctx.get('retryQueue', false);
        if (retryQueue) {
          try {
            await retryQueue.enqueue({
              kind: 'bump_item',
              payload: { itemId: item.id, priorityStatusId: prem.id },
              dedupeKey: `bump:${item.id}`,
              error: msg,
            });
          } catch (enqueueErr) {
            // Keep the API error as the reported one: replacing it with the queue error
            // would hide why the bump actually failed.
            this.log.error(
              `Не удалось поставить поднятие «${item.name}» в очередь повторов: ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}`,
            );
          }
        }
        throw bumpErr;
      }

      this.ctx.storage.update<BumpedItems>('bumped_items', (map) => {
        map[item.id] = new Date().toISOString();
      });

      this.log.info(
        `«${item.name}» поднят${reason ? ` (${reason})` : ''}. Позиция: ${item.sequence ?? '?'} -> 1`,
      );

      auditOnce(this.ctx, {
        action: 'bump.ok',
        title: `Товар «${item.name}» поднят`,
        details: {
          itemId: item.id,
          previousPosition: item.sequence ?? undefined,
          reason,
        },
      });

      await announceSafely(this.ctx, 'item/bumped', {
        itemId: item.id,
        slug: item.slug,
        name: item.name,
        previousPosition: item.sequence,
        reason,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Ошибка поднятия товара «${itemOrProfile.name}»: ${msg}`);
      auditOnce(this.ctx, {
        action: 'bump.failed',
        outcome: 'failed',
        title: `Ошибка поднятия товара «${itemOrProfile.name}»`,
        details: { itemId: itemOrProfile.id, error: msg },
      });
      await notifySafely(this.ctx, {
        eventKey: 'item_bumped',
        title: `❌ Ошибка при поднятии товара «${itemOrProfile.name}»`,
        body: `<blockquote>${msg}</blockquote>`,
      });
      return false;
    }
  }

  public async bumpItems(now: Date = new Date()): Promise<{ total: number; bumped: number }> {
    this.ctx.storage.updateConfig((cfg) => {
      cfg.playerok.auto_bump_items.last_time = now.toISOString();
    });

    const items = await this.ctx.playerok.getMyItems({ statuses: [ItemStatuses.APPROVED] });
    const candidates = items.filter((it) => it.priority !== PriorityTypes.DEFAULT);
    let bumped = 0;

    for (const item of candidates) {
      if (await this.bumpItem(item)) bumped += 1;
    }

    this.cleanOldBumpedItems(now);
    return { total: candidates.length, bumped };
  }

  public async checkItemsPositions(now: Date = new Date()): Promise<{ total: number; bumped: number }> {
    this.ctx.storage.updateConfig((cfg) => {
      cfg.playerok.auto_bump_items.last_check_time = now.toISOString();
    });

    const cfg = this.ctx.storage.getConfig();
    const threshold = getCurrentBumpPosition(cfg, now);
    const cooldown = cfg.playerok.auto_bump_items.cooldown || 0;

    const items = await this.ctx.playerok.getMyItems({ statuses: [ItemStatuses.APPROVED] });
    const candidates = items.filter(
      (it) => it.priority !== PriorityTypes.DEFAULT && this.isBumpItemMatched(it),
    );

    const bumpedHistory = this.ctx.storage.getBumpedItems();
    const checkedIds = new Set<string>();
    let bumped = 0;

    for (const item of candidates) {
      checkedIds.add(item.id);
      let full: MyItem;
      try {
        full = await this.ctx.playerok.getItem({ id: item.id });
      } catch (err) {
        this.log.error(`Не удалось получить позицию товара «${item.name}»: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (full.sequence === null || full.sequence === undefined) {
        this.itemPositions.delete(full.id);
        continue;
      }

      const outOfRange = full.sequence > threshold;
      const prev = this.itemPositions.get(full.id);
      const streak = outOfRange ? (prev?.streak ?? 0) + 1 : 0;

      this.itemPositions.set(full.id, {
        name: full.name,
        slug: full.slug,
        position: full.sequence,
        streak,
        checkedAt: now.toISOString(),
      });

      if (streak < 2) continue;
      if (!isDue(bumpedHistory[full.id], cooldown, now)) continue;

      if (await this.bumpItem(full, `выпал на ${full.sequence} место`)) {
        bumped += 1;
        this.itemPositions.set(full.id, {
          name: full.name,
          slug: full.slug,
          position: 1,
          streak: 0,
          checkedAt: now.toISOString(),
        });
      }
    }

    for (const id of Array.from(this.itemPositions.keys())) {
      if (!checkedIds.has(id)) this.itemPositions.delete(id);
    }

    this.cleanOldBumpedItems(now);
    return { total: candidates.length, bumped };
  }

  public cleanOldBumpedItems(now: Date = new Date()): void {
    const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    this.ctx.storage.update<BumpedItems>('bumped_items', (map) => {
      for (const [id, iso] of Object.entries(map)) {
        const ts = Date.parse(iso);
        if (Number.isNaN(ts) || ts < cutoff) {
          delete map[id];
        }
      }
    });
  }
}

declare module 'cordis' {
  interface Context {
    autoBump: AutoBumpService;
  }
}
