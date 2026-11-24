import {
  bindingKey,
  Context,
  GameCategoryDataFieldTypes,
  itemMatchesAnyBinding,
  itemMatchesBinding,
  ItemStatuses,
  PriorityTypes,
  Service,
  type DataField,
  type DataReplacementRule,
  type ItemPriorityStatus,
  type ItemProfile,
  type MyItem,
} from '@playerok/core';
import '@playerok/adapter';

export interface AutoRestoreConfig {
  expiredCheckIntervalMs?: number;
  enableTimer?: boolean;
}

export class AutoRestoreService extends Service {
  static provide = 'autoRestore';
  static inject = ['storage', 'playerok'];

  private readonly log;
  private readonly recreatedItems = new Set<string>();

  constructor(ctx: Context, config: AutoRestoreConfig = {}) {
    super(ctx, 'autoRestore');
    this.log = ctx.logger('automation.restore');

    ctx.on('playerok/item-paid', async (event) => {
      if (event.deal.user.id === ctx.playerok.account?.id) return;
      if (!ctx.storage.getConfig().playerok.auto_restore_items.sold) return;

      const soldItems = await ctx.playerok.getMyItems({
        count: 24,
        statuses: [ItemStatuses.SOLD],
      });
      const target = soldItems.find(
        (it) =>
          it.id === event.deal.item.id ||
          (it.name === event.deal.item.name &&
            (!event.deal.item.priority || it.priority === event.deal.item.priority)),
      );
      if (target) {
        await this.restoreItem(target);
      }
    });

    if (config.enableTimer !== false) {
      const interval = config.expiredCheckIntervalMs ?? 45_000;
      ctx.effect(() => {
        const timer = setInterval(() => {
          if (ctx.storage.getConfig().playerok.auto_restore_items.expired) {
            void this.restoreExpiredItems();
          }
        }, interval);
        timer.unref?.();
        return () => clearInterval(timer);
      }, 'autoRestore:expiredTimer');
    }
  }

  private isRestoreMatched(item: ItemProfile | MyItem): boolean {
    const cfg = this.ctx.storage.getConfig().playerok.auto_restore_items;
    const lists = this.ctx.storage.getAutoRestoreItems();
    const included = itemMatchesAnyBinding(item, lists.included);
    const excluded = itemMatchesAnyBinding(item, lists.excluded);
    return (cfg.all && !excluded) || (!cfg.all && included);
  }

  private prepareItemData(
    item: MyItem,
  ): { rule: DataReplacementRule; rawLine: string; fields: DataField[] } | null {
    const rules = this.ctx.storage.getDataReplacement();
    const rule = rules.find((r) => r.enabled && itemMatchesBinding(item, r));
    if (!rule) return null;

    if (!rule.data || rule.data.length === 0) {
      throw new Error('данные для замены закончились');
    }

    const fields = (item.dataFields ?? [])
      .filter((f) => f.type === GameCategoryDataFieldTypes.ITEM_DATA)
      .map((f) => ({ ...f }));
    if (fields.length === 0) {
      throw new Error('у товара нет полей с данными для замены');
    }

    const rawLine = rule.data[0];
    const sep = rule.separator || ':';
    const values = rawLine.split(sep);
    if (values.length < fields.length) {
      throw new Error(
        `в строке данных «${rawLine}» ${values.length} значений, а у товара ${fields.length} полей`,
      );
    }

    for (let i = 0; i < fields.length; i++) {
      fields[i].value = values[i].trim();
    }

    return { rule, rawLine, fields };
  }

  private consumeItemData(rule: DataReplacementRule, rawLine: string): number {
    const key = bindingKey(rule);
    let remaining = 0;
    this.ctx.storage.update<DataReplacementRule[]>('data_replacement', (rules) => {
      const target = rules.find((r) => bindingKey(r) === key && r.data.includes(rawLine));
      if (!target) return;
      const idx = target.data.indexOf(rawLine);
      if (idx !== -1) target.data.splice(idx, 1);
      remaining = target.data.length;
    });
    return remaining;
  }

  private async publishRestoredItem(
    itemId: string,
    rawPrice: number,
    isPremium: boolean,
  ): Promise<{ item: MyItem; status: ItemPriorityStatus }> {
    const cfg = this.ctx.storage.getConfig().playerok.auto_restore_items;
    const statuses = await this.ctx.playerok.getItemPriorityStatuses(itemId, rawPrice);
    if (statuses.length === 0) {
      throw new Error('Статусы приоритета не найдены');
    }

    const prem = statuses.find((s) => s.type === PriorityTypes.PREMIUM || s.price > 0);
    const free = statuses.find((s) => s.type === PriorityTypes.DEFAULT || s.price === 0);

    let chosen: ItemPriorityStatus;
    if (isPremium || cfg.publish_status === 'premium') {
      if (!prem) throw new Error('PREMIUM статус приоритета не найден');
      chosen = prem;
    } else {
      chosen = free ?? statuses[0];
    }

    try {
      const published = await this.ctx.playerok.publishItem(itemId, chosen.id);
      return { item: published, status: chosen };
    } catch (err) {
      if (chosen.type === PriorityTypes.PREMIUM || !prem || !cfg.premium) {
        throw err;
      }
      this.log.warn(`Не удалось восстановить с бесплатным статусом, пробую премиум`);
      const published = await this.ctx.playerok.publishItem(itemId, prem.id);
      return { item: published, status: prem };
    }
  }

  public async restoreItem(itemOrProfile: ItemProfile | MyItem): Promise<boolean> {
    const cfg = this.ctx.storage.getConfig().playerok.auto_restore_items;
    if (!this.isRestoreMatched(itemOrProfile)) return false;

    try {
      let item: MyItem =
        'mayBePublished' in itemOrProfile
          ? itemOrProfile
          : await this.ctx.playerok.getItem({ id: itemOrProfile.id });

      const isPremium = item.priority === PriorityTypes.PREMIUM;
      if (isPremium && !cfg.premium) return false;
      if (!isPremium && !cfg.free) return false;

      const shouldRecreate = item.mayBePublished === false;
      let newItem: MyItem;
      let chosenStatus: ItemPriorityStatus;
      let dataReplacedRemaining: number | undefined;
      let oldRemoved = true;

      if (shouldRecreate) {
        if (!cfg.recreate) {
          this.log.warn(`Товар «${item.name}» нельзя перевыставить; включите recreate в настройках`);
          return false;
        }
        if (this.recreatedItems.has(item.id)) return false;

        if (!item.category || !item.obtainingType) {
          throw new Error('у товара нет категории или способа получения');
        }

        const prepared = this.prepareItemData(item);
        const downloadedAttachments: Array<{ filename: string; data: Buffer; contentType?: string }> = [];
        for (const att of item.attachments ?? []) {
          if (!att.url) continue;
          try {
            const data = await this.ctx.playerok.downloadFile(att.url);
            downloadedAttachments.push({
              filename: att.filename || `attachment-${att.id || downloadedAttachments.length}.jpg`,
              data,
              contentType: att.mime || 'image/jpeg',
            });
          } catch {
            // keep going if single attachment download fails
          }
        }

        const draft = await this.ctx.playerok.createItem({
          gameCategoryId: item.category.id,
          obtainingTypeId: item.obtainingType.id,
          name: item.name,
          price: item.rawPrice,
          description: item.description ?? '',
          options: item.attributes ?? {},
          dataFields:
            prepared?.fields ??
            (item.dataFields ?? []).filter((f) => f.type === GameCategoryDataFieldTypes.ITEM_DATA),
          attachments: downloadedAttachments,
        });

        try {
          const res = await this.publishRestoredItem(draft.id, item.rawPrice, isPremium);
          newItem = res.item;
          chosenStatus = res.status;
        } catch (err) {
          await this.ctx.playerok.removeItem(draft.id).catch(() => {});
          throw err;
        }

        this.recreatedItems.add(item.id);
        if (prepared) {
          dataReplacedRemaining = this.consumeItemData(prepared.rule, prepared.rawLine);
        }

        const rebound = this.ctx.storage.rebindItem(item.id, {
          id: newItem.id,
          slug: newItem.slug || item.slug,
          name: newItem.name || item.name,
        });
        if (rebound > 0) {
          this.log.info(`Привязки перенесены на пересозданный товар «${item.name}» (${rebound})`);
        }

        oldRemoved = await this.ctx.playerok.removeItem(item.id).catch(() => false);
      } else {
        const prepared = this.prepareItemData(item);
        if (prepared) {
          await this.ctx.playerok.updateItem(item.id, { dataFields: prepared.fields });
        }
        const res = await this.publishRestoredItem(item.id, item.rawPrice, isPremium);
        newItem = res.item;
        chosenStatus = res.status;
        if (prepared) {
          dataReplacedRemaining = this.consumeItemData(prepared.rule, prepared.rawLine);
        }
      }

      const premResult = chosenStatus.type === PriorityTypes.PREMIUM;
      this.log.info(
        `Товар «${item.name}» ${shouldRecreate ? 'пересоздан' : 'восстановлен'} (${premResult ? 'премиум' : 'бесплатный'})`,
      );

      await this.ctx.parallel('item/restored', {
        itemId: newItem.id,
        oldItemId: shouldRecreate ? item.id : undefined,
        slug: newItem.slug || item.slug,
        name: newItem.name || item.name,
        isPremium: premResult,
        recreated: shouldRecreate,
        dataReplacedRemaining,
        oldRemoved,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Ошибка при восстановлении товара «${itemOrProfile.name}»: ${message}`);
      await this.ctx.parallel('notify/log', {
        eventKey: 'item_restored',
        title: `❌ Ошибка при восстановлении товара «${itemOrProfile.name}»`,
        body: `<blockquote>${message}</blockquote>`,
      });
      return false;
    }
  }

  public async restoreExpiredItems(): Promise<number> {
    let restored = 0;
    try {
      const expired = await this.ctx.playerok.getMyItems({ statuses: [ItemStatuses.EXPIRED] });
      const seen = new Set<string>();
      for (const item of expired) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (await this.restoreItem(item)) {
          restored += 1;
        }
      }
    } catch (err) {
      this.log.error(`Ошибка при восстановлении истёкших товаров: ${err instanceof Error ? err.message : String(err)}`);
    }
    return restored;
  }
}

declare module 'cordis' {
  interface Context {
    autoRestore: AutoRestoreService;
  }
}
