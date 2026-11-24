import {
  Context,
  EventTypes,
  ItemStatuses,
  Service,
  type AccountInfo,
  type Chat,
  type ChatMessage,
  type DealEvent,
  type ItemDeal,
  type ItemDealStatuses,
  type ItemPriorityStatus,
  type ItemProfile,
  type MyItem,
  type PaginatedList,
  type PlayerokEvent,
  type Review,
  type SbpBankMember,
  type SetupProblem,
  type Transaction,
  type UserProfile,
  type VerifiedCard,
} from '@pkh/core';
import {
  AccountBlockedError,
  BotCheckDetectedError,
  UnauthorizedError,
} from './errors.js';
import { GraphQLPlayerokTransport } from './graphql-transport.js';
import { MockPlayerokTransport, type MockTransportSeed } from './mock-transport.js';
import type {
  BinaryUpload,
  CreateItemParams,
  GetDealsParams,
  GetMyItemsParams,
  GetReviewsParams,
  PlayerokTransport,
  RequestWithdrawalParams,
  UpdateItemParams,
} from './transport.js';

export interface PlayerokServiceConfig {
  dryRun?: boolean;
  transport?: PlayerokTransport;
  mockSeed?: MockTransportSeed;
  enableMaintenanceLoops?: boolean;
}

const EVENT_TYPE_TO_CORDIS: Record<EventTypes, keyof import('cordis').Events> = {
  [EventTypes.CHAT_INITIALIZED]: 'playerok/chat-initialized',
  [EventTypes.NEW_MESSAGE]: 'playerok/new-message',
  [EventTypes.NEW_DEAL]: 'playerok/new-deal',
  [EventTypes.NEW_REVIEW]: 'playerok/new-review',
  [EventTypes.DEAL_CONFIRMED]: 'playerok/deal-confirmed',
  [EventTypes.DEAL_CONFIRMED_AUTOMATICALLY]: 'playerok/deal-confirmed-automatically',
  [EventTypes.DEAL_ROLLED_BACK]: 'playerok/deal-rolled-back',
  [EventTypes.DEAL_HAS_PROBLEM]: 'playerok/deal-has-problem',
  [EventTypes.DEAL_PROBLEM_RESOLVED]: 'playerok/deal-problem-resolved',
  [EventTypes.DEAL_STATUS_CHANGED]: 'playerok/deal-status-changed',
  [EventTypes.ITEM_PAID]: 'playerok/item-paid',
  [EventTypes.ITEM_SENT]: 'playerok/item-sent',
};

const SERIAL_EVENTS = new Set<keyof import('cordis').Events>([
  'playerok/new-deal',
  'playerok/item-paid',
]);

export class PlayerokService extends Service {
  static provide = 'playerok';
  static inject = ['storage'];

  public readonly isDryRun: boolean;
  public transport: PlayerokTransport;
  public account: AccountInfo | null = null;
  public setupProblem: SetupProblem | null = null;

  private readonly log;
  private readonly customTransport: boolean;
  private unsubscribeFn: (() => void) | null = null;
  private readonly chatCache = new Map<string, Chat>();

  constructor(ctx: Context, config: PlayerokServiceConfig = {}) {
    super(ctx, 'playerok');
    this.log = ctx.logger('playerok');
    this.isDryRun = Boolean(config.dryRun);
    this.customTransport = Boolean(config.transport);

    if (config.transport) {
      this.transport = config.transport;
    } else if (this.isDryRun) {
      this.transport = new MockPlayerokTransport(config.mockSeed);
    } else {
      this.transport = this.buildLiveTransport();
    }

    ctx.effect(() => {
      let refreshTimer: NodeJS.Timeout | undefined;
      let banTimer: NodeJS.Timeout | undefined;

      if (config.enableMaintenanceLoops !== false) {
        refreshTimer = setInterval(() => {
          if (this.account) void this.refreshAccount();
        }, 30 * 60 * 1000);
        refreshTimer.unref?.();

        banTimer = setInterval(() => {
          if (this.account) void this.checkBanned();
        }, 15 * 60 * 1000);
        banTimer.unref?.();
      }

      return async () => {
        if (refreshTimer) clearInterval(refreshTimer);
        if (banTimer) clearInterval(banTimer);
        await this.stopListening();
        await this.transport.close();
      };
    }, 'playerok:lifecycle');
  }

  private buildLiveTransport(): GraphQLPlayerokTransport {
    const apiCfg = this.ctx.storage.getConfig().playerok.api;
    return new GraphQLPlayerokTransport({
      cookies: apiCfg.cookies,
      userAgent: apiCfg.user_agent || undefined,
      proxy: apiCfg.proxy || undefined,
      timeoutMs: apiCfg.requests_timeout * 1000,
    });
  }

  /**
   * Rebuilds the live GraphQL transport after cookies/proxy/UA were updated in Telegram.
   */
  public async reconfigureTransport(): Promise<void> {
    if (this.isDryRun || this.customTransport) return;
    await this.stopListening();
    await this.transport.close().catch(() => {});
    this.transport = this.buildLiveTransport();
  }

  /**
   * Classifies any connectivity or auth issue into a structured SetupProblem
   * so the bot can enter setup mode instead of crashing.
   */
  public async diagnose(): Promise<SetupProblem | null> {
    if (!this.isDryRun && !this.customTransport) {
      const cookies = this.ctx.storage.getConfig().playerok.api.cookies.trim();
      if (!cookies) {
        const problem: SetupProblem = {
          code: 'missing_cookies',
          text: 'Не указаны cookies аккаунта PlayerOK. Укажите их в настройках подключения.',
          transient: false,
        };
        this.setupProblem = problem;
        return problem;
      }
    }

    try {
      const account = await this.transport.getAccount();
      if (account.isBlocked) {
        const problem: SetupProblem = {
          code: 'blocked',
          text: `Аккаунт PlayerOK заблокирован${account.isBlockedFor ? `: ${account.isBlockedFor}` : ''}`,
          transient: false,
        };
        this.setupProblem = problem;
        return problem;
      }
      this.account = account;
      this.setupProblem = null;
      return null;
    } catch (err) {
      let problem: SetupProblem;
      if (err instanceof BotCheckDetectedError) {
        problem = {
          code: 'bot_check',
          text: err.message,
          transient: false,
        };
      } else if (err instanceof UnauthorizedError) {
        problem = {
          code: 'unauthorized',
          text: `Ошибка авторизации PlayerOK: ${err.message}`,
          transient: false,
        };
      } else if (err instanceof AccountBlockedError) {
        problem = {
          code: 'blocked',
          text: err.message,
          transient: false,
        };
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        const transient = /abort|timeout|ECONN|ENOTFOUND|fetch failed|502|503|504/i.test(msg);
        problem = {
          code: transient ? 'network' : 'unknown',
          text: msg,
          transient,
        };
      }
      this.setupProblem = problem;
      return problem;
    }
  }

  public async connect(): Promise<AccountInfo> {
    this.account = await this.transport.getAccount();
    if (this.account.isBlocked) {
      throw new AccountBlockedError(this.account.isBlockedFor);
    }
    this.setupProblem = null;
    this.log.info(
      `Подключен аккаунт PlayerOK: ${this.account.username} (ID: ${this.account.id}, режим: ${this.isDryRun ? 'DRY-RUN' : this.transport.kind})`,
    );
    return this.account;
  }

  public async refreshAccount(): Promise<AccountInfo | null> {
    try {
      this.account = await this.transport.getAccount();
      return this.account;
    } catch (err) {
      this.log.error(`Ошибка при обновлении аккаунта: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  public async checkBanned(): Promise<boolean> {
    if (!this.account) return false;
    try {
      const user = await this.transport.getUser(this.account.id);
      if (user.isBlocked) {
        this.log.error('Аккаунт PlayerOK заблокирован!');
        return true;
      }
      return false;
    } catch (err) {
      this.log.error(`Ошибка проверки блокировки: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  public async startListening(): Promise<void> {
    if (this.unsubscribeFn) return;
    if (!this.account) {
      await this.connect();
    }
    this.unsubscribeFn = await this.transport.subscribe(async (event) => {
      await this.dispatchEvent(event);
    });
    this.log.info('Слушатель событий PlayerOK запущен');
  }

  public async stopListening(): Promise<void> {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }
  }

  public async dispatchEvent(event: PlayerokEvent): Promise<void> {
    const cordisEvent = EVENT_TYPE_TO_CORDIS[event.type];
    if (!cordisEvent) return;
    const hooks = [...(this.ctx.events._hooks[cordisEvent] ?? [])];

    const runHook = async (hook: (typeof hooks)[number]) => {
      if (hook.removed) return;
      try {
        await hook.callback(event);
      } catch (err) {
        this.log.error(
          `Ошибка в обработчике события ${String(cordisEvent)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    if (SERIAL_EVENTS.has(cordisEvent)) {
      for (const hook of hooks) {
        await runHook(hook);
      }
      return;
    }

    await Promise.all(hooks.map(runHook));
  }

  public isSupportOrSystemChat(chatId: string): boolean {
    if (!this.account) return false;
    return chatId === this.account.supportChatId || chatId === this.account.systemChatId;
  }

  public getChatOtherUser(chat: Chat): UserProfile | null {
    const myId = this.account?.id;
    return chat.users.find((u) => u.id !== myId) ?? chat.users[0] ?? null;
  }

  public getDealUsername(event: Pick<DealEvent, 'deal' | 'chat'>): string | null {
    return event.deal.user?.username || this.getChatOtherUser(event.chat)?.username || null;
  }

  public async sendMessage(
    chatId: string,
    text: string | null | undefined,
    options: {
      images?: BinaryUpload[];
      markChatAsRead?: boolean;
      excludeWatermark?: boolean;
      maxAttempts?: number;
    } = {},
  ): Promise<ChatMessage | null> {
    if (!text && (!options.images || options.images.length === 0)) return null;

    const cfg = this.ctx.storage.getConfig().playerok;
    let finalText = text ?? null;
    if (finalText && cfg.watermark.enabled && cfg.watermark.value && !options.excludeWatermark) {
      finalText += `\n${cfg.watermark.value}`;
    }

    const markChatAsRead = options.markChatAsRead ?? cfg.read_chat;
    const attempts = options.maxAttempts ?? 3;
    let lastError: unknown;

    for (let i = 0; i < attempts; i++) {
      try {
        return await this.transport.sendMessage({
          chatId,
          text: finalText,
          images: options.images,
          markChatAsRead,
        });
      } catch (err) {
        lastError = err;
      }
    }

    this.log.error(
      `Не удалось отправить сообщение в чат ${chatId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    return null;
  }

  public async getMyItems(params: GetMyItemsParams = {}): Promise<ItemProfile[]> {
    const statuses = params.statuses ?? [ItemStatuses.APPROVED];
    const requestedCount = params.count ?? -1;
    const result: ItemProfile[] = [];
    let cursor: string | null | undefined = params.afterCursor;

    try {
      while (true) {
        const page = await this.transport.getMyItems({
          ...params,
          statuses,
          afterCursor: cursor,
          count: requestedCount !== -1 ? requestedCount : 24,
        });
        for (const item of page.items) {
          result.push(item);
          if (requestedCount !== -1 && result.length >= requestedCount) {
            return result;
          }
        }
        if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) {
          break;
        }
        cursor = page.pageInfo.endCursor;
      }

      if (requestedCount === -1) {
        this.ctx.storage.set('saved_items', result);
      }
      return result;
    } catch (err) {
      const cached = this.ctx.storage.get<ItemProfile[]>('saved_items');
      const filtered = cached.filter((it) => !statuses || (it.status && statuses.includes(it.status)));
      if (filtered.length > 0) {
        this.log.warn('Использован кэш saved_items из-за ошибки получения списка товаров');
        return requestedCount !== -1 ? filtered.slice(0, requestedCount) : filtered;
      }
      throw err;
    }
  }

  public async getChat(chatId: string, useCache = true): Promise<Chat> {
    if (useCache && this.chatCache.has(chatId)) {
      return this.chatCache.get(chatId)!;
    }
    const chat = await this.transport.getChat(chatId);
    this.chatCache.set(chatId, chat);
    return chat;
  }

  public getChats(count = 24, afterCursor?: string | null): Promise<PaginatedList<Chat>> {
    return this.transport.getChats(count, afterCursor);
  }

  public getChatMessages(chatId: string, count = 24): Promise<ChatMessage[]> {
    return this.transport.getChatMessages(chatId, count);
  }

  public markChatAsRead(chatId: string): Promise<void> {
    return this.transport.markChatAsRead(chatId);
  }

  public downloadFile(url: string): Promise<Buffer> {
    return this.transport.downloadFile(url);
  }

  public getItem(ref: { id?: string; slug?: string }): Promise<MyItem> {
    return this.transport.getItem(ref);
  }

  public getItemPriorityStatuses(itemId: string, rawPrice: number): Promise<ItemPriorityStatus[]> {
    return this.transport.getItemPriorityStatuses(itemId, rawPrice);
  }

  public increaseItemPriorityStatus(itemId: string, priorityStatusId: string): Promise<MyItem> {
    return this.transport.increaseItemPriorityStatus(itemId, priorityStatusId);
  }

  public publishItem(itemId: string, priorityStatusId: string): Promise<MyItem> {
    return this.transport.publishItem(itemId, priorityStatusId);
  }

  public createItem(params: CreateItemParams): Promise<MyItem> {
    return this.transport.createItem(params);
  }

  public updateItem(itemId: string, params: UpdateItemParams): Promise<MyItem> {
    return this.transport.updateItem(itemId, params);
  }

  public removeItem(itemId: string): Promise<boolean> {
    return this.transport.removeItem(itemId);
  }

  public getDeals(params?: GetDealsParams): Promise<PaginatedList<ItemDeal>> {
    return this.transport.getDeals(params);
  }

  public getDeal(dealId: string): Promise<ItemDeal> {
    return this.transport.getDeal(dealId);
  }

  public updateDeal(dealId: string, status: ItemDealStatuses): Promise<ItemDeal> {
    return this.transport.updateDeal(dealId, status);
  }

  public reportDealProblem(dealId: string, description: string, problemTypeId: string): Promise<ItemDeal> {
    return this.transport.reportDealProblem(dealId, description, problemTypeId);
  }

  public getReviews(params?: GetReviewsParams): Promise<PaginatedList<Review>> {
    return this.transport.getReviews(params);
  }

  public getTransactions(count = 24, afterCursor?: string | null): Promise<PaginatedList<Transaction>> {
    return this.transport.getTransactions(count, afterCursor);
  }

  public getSbpBankMembers(): Promise<SbpBankMember[]> {
    return this.transport.getSbpBankMembers();
  }

  public getVerifiedCards(): Promise<VerifiedCard[]> {
    return this.transport.getVerifiedCards();
  }

  public requestWithdrawal(params: RequestWithdrawalParams): Promise<Transaction> {
    return this.transport.requestWithdrawal(params);
  }

  public removeTransaction(transactionId: string): Promise<Transaction> {
    return this.transport.removeTransaction(transactionId);
  }
}

declare module 'cordis' {
  interface Context {
    playerok: PlayerokService;
  }
}
