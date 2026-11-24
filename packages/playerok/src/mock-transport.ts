import crypto from 'node:crypto';
import {
  ChatStatuses,
  ChatTypes,
  EventTypes,
  GameCategoryDataFieldTypes,
  ItemDealDirections,
  ItemDealStatuses,
  ItemStatuses,
  PriorityTypes,
  ReviewStatuses,
  TransactionDirections,
  TransactionOperations,
  TransactionProviderIds,
  TransactionStatuses,
  UserTypes,
  type AccountInfo,
  type Chat,
  type ChatMessage,
  type ItemDeal,
  type ItemPriorityStatus,
  type ItemProfile,
  type MyItem,
  type PaginatedList,
  type PlayerokEvent,
  type Review,
  type SbpBankMember,
  type Transaction,
  type UserProfile,
  type VerifiedCard,
} from '@playerok/core';
import type {
  CreateItemParams,
  GetDealsParams,
  GetMyItemsParams,
  GetReviewsParams,
  PlayerokEventHandler,
  PlayerokTransport,
  RequestWithdrawalParams,
  SendMessageParams,
  UpdateItemParams,
} from './transport.js';

export interface MockTransportSeed {
  account?: Partial<AccountInfo>;
  items?: MyItem[];
  chats?: Chat[];
  deals?: ItemDeal[];
  reviews?: Review[];
  transactions?: Transaction[];
}

export class MockPlayerokTransport implements PlayerokTransport {
  public readonly kind = 'mock';

  public account: AccountInfo;
  public readonly items = new Map<string, MyItem>();
  public readonly chats = new Map<string, Chat>();
  public readonly messagesByChat = new Map<string, ChatMessage[]>();
  public readonly deals = new Map<string, ItemDeal>();
  public readonly reviews: Review[] = [];
  public readonly transactions: Transaction[] = [];
  public readonly sentMessages: Array<SendMessageParams & { message: ChatMessage }> = [];
  public readonly publishedItems: Array<{ itemId: string; priorityStatusId: string }> = [];
  public readonly bumpedItemIds: string[] = [];
  public readonly removedItemIds: string[] = [];
  public readonly updatedDeals: Array<{ dealId: string; status: ItemDealStatuses }> = [];
  public readonly withdrawalRequests: RequestWithdrawalParams[] = [];

  private readonly handlers = new Set<PlayerokEventHandler>();

  constructor(seed: MockTransportSeed = {}) {
    const ownerProfile: UserProfile = {
      id: seed.account?.id ?? 'seller-001',
      username: seed.account?.username ?? 'DemoSeller',
      role: UserTypes.USER,
      isOnline: true,
      isBlocked: false,
      rating: 4.98,
      reviewsCount: 142,
      supportChatId: 'chat-support',
      systemChatId: 'chat-system',
      createdAt: '2025-01-01T00:00:00.000Z',
    };

    this.account = {
      id: ownerProfile.id,
      username: ownerProfile.username,
      email: 'demo@example.com',
      role: 'USER',
      supportChatId: 'chat-support',
      systemChatId: 'chat-system',
      unreadChatsCounter: 0,
      isBlocked: false,
      isBlockedFor: null,
      createdAt: ownerProfile.createdAt,
      hasFrozenBalance: false,
      hasConfirmedPhoneNumber: true,
      canPublishItems: true,
      profile: {
        ...ownerProfile,
        balance: {
          id: 'bal-001',
          value: 4500,
          frozen: 0,
          available: 3200,
          withdrawable: 3200,
          pendingIncome: 1300,
        },
        stats: {
          items: { total: 12, finished: 10 },
          deals: {
            incoming: { total: 2, finished: 2 },
            outgoing: { total: 54, finished: 52 },
          },
        },
      },
      ...seed.account,
    };

    const defaultItems: MyItem[] = seed.items ?? [
      {
        id: '11111111-1111-1111-1111-111111111111',
        slug: 'steam-key-cyber',
        name: 'Steam Key Cyber Edition',
        price: 500,
        rawPrice: 450,
        priority: PriorityTypes.PREMIUM,
        status: ItemStatuses.APPROVED,
        sequence: 3,
        mayBePublished: true,
        user: ownerProfile,
        description: 'Лицензионный ключ Steam',
        category: { id: 'cat-steam', name: 'Steam Keys' },
        obtainingType: { id: 'obt-auto', name: 'Автовыдача' },
        dataFields: [
          { id: 'df-1', label: 'Логин', type: GameCategoryDataFieldTypes.ITEM_DATA, value: 'old_login' },
          { id: 'df-2', label: 'Пароль', type: GameCategoryDataFieldTypes.ITEM_DATA, value: 'old_pass' },
        ],
        attachments: [],
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        slug: 'valorant-vp-1000',
        name: 'Valorant 1000 VP',
        price: 890,
        rawPrice: 800,
        priority: PriorityTypes.DEFAULT,
        status: ItemStatuses.EXPIRED,
        sequence: 15,
        mayBePublished: true,
        user: ownerProfile,
        description: 'Быстрое пополнение VP',
        category: { id: 'cat-val', name: 'Valorant' },
        obtainingType: { id: 'obt-auto', name: 'Автовыдача' },
        dataFields: [],
        attachments: [],
      },
    ];
    for (const item of defaultItems) {
      this.items.set(item.id, structuredClone(item));
    }

    const demoBuyer: UserProfile = {
      id: 'buyer-001',
      username: 'DemoBuyer',
      role: UserTypes.USER,
      isOnline: true,
      isBlocked: false,
      rating: 5,
      reviewsCount: 4,
    };

    const defaultChats: Chat[] = seed.chats ?? [
      {
        id: 'chat-demo-1',
        type: ChatTypes.PM,
        status: ChatStatuses.FINISHED,
        unreadMessagesCounter: 0,
        users: [ownerProfile, demoBuyer],
      },
    ];
    for (const chat of defaultChats) {
      this.chats.set(chat.id, structuredClone(chat));
      this.messagesByChat.set(chat.id, []);
    }

    for (const deal of seed.deals ?? []) {
      this.deals.set(deal.id, structuredClone(deal));
    }

    if (seed.reviews) {
      this.reviews.push(...seed.reviews);
    } else {
      this.reviews.push({
        id: 'rev-001',
        status: ReviewStatuses.APPROVED,
        rating: 5,
        text: 'Всё пришло мгновенно, рекомендую!',
        createdAt: new Date().toISOString(),
        creator: demoBuyer,
        dealId: 'deal-demo-0',
      });
    }

    if (seed.transactions) {
      this.transactions.push(...seed.transactions);
    } else {
      this.transactions.push({
        id: 'tx-001',
        operation: TransactionOperations.SELL,
        direction: TransactionDirections.IN,
        providerId: TransactionProviderIds.LOCAL,
        status: TransactionStatuses.CONFIRMED,
        value: 500,
        createdAt: new Date().toISOString(),
      });
    }
  }

  public async getAccount(): Promise<AccountInfo> {
    return structuredClone(this.account);
  }

  public async getUser(userId: string): Promise<UserProfile> {
    if (userId === this.account.id) return structuredClone(this.account.profile);
    for (const chat of this.chats.values()) {
      const found = chat.users.find((u) => u.id === userId);
      if (found) return structuredClone(found);
    }
    return { id: userId, username: `user_${userId}`, isBlocked: false };
  }

  public async getChats(count = 24): Promise<PaginatedList<Chat>> {
    const items = Array.from(this.chats.values()).slice(0, count).map((c) => structuredClone(c));
    return { items, pageInfo: { hasNextPage: false } };
  }

  public async getChat(chatId: string): Promise<Chat> {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error(`Mock chat not found: ${chatId}`);
    return structuredClone(chat);
  }

  public async getChatMessages(chatId: string, count = 24): Promise<ChatMessage[]> {
    const msgs = this.messagesByChat.get(chatId) ?? [];
    return msgs.slice(-count).map((m) => structuredClone(m));
  }

  public async markChatAsRead(chatId: string): Promise<void> {
    const chat = this.chats.get(chatId);
    if (chat) chat.unreadMessagesCounter = 0;
  }

  public async sendMessage(params: SendMessageParams): Promise<ChatMessage> {
    const images = (params.images ?? []).map((img, i) => ({
      id: `img-${i}-${crypto.randomUUID().slice(0, 6)}`,
      url: `https://mock.playerok.local/uploads/${encodeURIComponent(img.filename)}`,
      filename: img.filename,
      mime: img.contentType ?? 'image/jpeg',
    }));
    const message: ChatMessage = {
      id: `msg-${crypto.randomUUID().slice(0, 8)}`,
      text: params.text ?? null,
      createdAt: new Date().toISOString(),
      isRead: Boolean(params.markChatAsRead),
      user: structuredClone(this.account.profile),
      images: images.length ? images : undefined,
    };
    const list = this.messagesByChat.get(params.chatId) ?? [];
    list.push(message);
    this.messagesByChat.set(params.chatId, list);
    const chat = this.chats.get(params.chatId);
    if (chat) chat.lastMessage = message;
    this.sentMessages.push({ ...params, message });
    return structuredClone(message);
  }

  public async downloadFile(_url: string): Promise<Buffer> {
    return Buffer.from('mock-image-bytes');
  }

  public async getMyItems(params: GetMyItemsParams = {}): Promise<PaginatedList<ItemProfile>> {
    let list = Array.from(this.items.values());
    if (params.statuses && params.statuses.length > 0) {
      list = list.filter((it) => it.status && params.statuses!.includes(it.status));
    }
    const limit = params.count && params.count > 0 ? params.count : list.length;
    return {
      items: list.slice(0, limit).map((i) => structuredClone(i)),
      pageInfo: { hasNextPage: false },
    };
  }

  public async getItem(ref: { id?: string; slug?: string }): Promise<MyItem> {
    if (ref.id && this.items.has(ref.id)) {
      return structuredClone(this.items.get(ref.id)!);
    }
    if (ref.slug) {
      for (const item of this.items.values()) {
        if (item.slug === ref.slug) return structuredClone(item);
      }
    }
    throw new Error(`Mock item not found: ${ref.id ?? ref.slug}`);
  }

  public async getItemPriorityStatuses(_itemId: string, _rawPrice: number): Promise<ItemPriorityStatus[]> {
    return [
      { id: 'prio-default', name: 'Бесплатный', price: 0, type: PriorityTypes.DEFAULT, period: 30 },
      { id: 'prio-premium', name: 'Премиум', price: 49, type: PriorityTypes.PREMIUM, period: 30 },
    ];
  }

  public async increaseItemPriorityStatus(itemId: string, _priorityStatusId: string): Promise<MyItem> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`Mock item not found: ${itemId}`);
    item.sequence = 1;
    item.priority = PriorityTypes.PREMIUM;
    this.bumpedItemIds.push(itemId);
    return structuredClone(item);
  }

  public async publishItem(itemId: string, priorityStatusId: string): Promise<MyItem> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`Mock item not found: ${itemId}`);
    item.status = ItemStatuses.APPROVED;
    item.priority = priorityStatusId === 'prio-premium' ? PriorityTypes.PREMIUM : PriorityTypes.DEFAULT;
    this.publishedItems.push({ itemId, priorityStatusId });
    return structuredClone(item);
  }

  public async createItem(params: CreateItemParams): Promise<MyItem> {
    const id = crypto.randomUUID();
    const slug = `${params.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(0, 6)}`;
    const item: MyItem = {
      id,
      slug,
      name: params.name,
      price: params.price,
      rawPrice: params.price,
      description: params.description,
      status: ItemStatuses.DRAFT,
      priority: PriorityTypes.DEFAULT,
      mayBePublished: true,
      user: structuredClone(this.account.profile),
      category: { id: params.gameCategoryId },
      obtainingType: { id: params.obtainingTypeId },
      dataFields: params.dataFields ? structuredClone(params.dataFields) : [],
      attributes: params.options ? structuredClone(params.options) : {},
      attachments: [],
    };
    this.items.set(id, item);
    return structuredClone(item);
  }

  public async updateItem(itemId: string, params: UpdateItemParams): Promise<MyItem> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`Mock item not found: ${itemId}`);
    if (params.name !== undefined) item.name = params.name;
    if (params.price !== undefined) {
      item.price = params.price;
      item.rawPrice = params.price;
    }
    if (params.description !== undefined) item.description = params.description;
    if (params.dataFields !== undefined) item.dataFields = structuredClone(params.dataFields);
    return structuredClone(item);
  }

  public async removeItem(itemId: string): Promise<boolean> {
    const deleted = this.items.delete(itemId);
    if (deleted) this.removedItemIds.push(itemId);
    return deleted;
  }

  public async getDeals(params: GetDealsParams = {}): Promise<PaginatedList<ItemDeal>> {
    let list = Array.from(this.deals.values());
    if (params.statuses && params.statuses.length > 0) {
      list = list.filter((d) => params.statuses!.includes(d.status));
    }
    if (params.direction) {
      list = list.filter((d) => d.direction === params.direction);
    }
    const limit = params.count && params.count > 0 ? params.count : list.length;
    return {
      items: list.slice(0, limit).map((d) => structuredClone(d)),
      pageInfo: { hasNextPage: false },
    };
  }

  public async getDeal(dealId: string): Promise<ItemDeal> {
    const deal = this.deals.get(dealId);
    if (!deal) throw new Error(`Mock deal not found: ${dealId}`);
    return structuredClone(deal);
  }

  public async updateDeal(dealId: string, status: ItemDealStatuses): Promise<ItemDeal> {
    const deal = this.deals.get(dealId);
    if (!deal) throw new Error(`Mock deal not found: ${dealId}`);
    deal.status = status;
    this.updatedDeals.push({ dealId, status });
    return structuredClone(deal);
  }

  public async reportDealProblem(dealId: string): Promise<ItemDeal> {
    const deal = this.deals.get(dealId);
    if (!deal) throw new Error(`Mock deal not found: ${dealId}`);
    deal.hasProblem = true;
    return structuredClone(deal);
  }

  public async getReviews(params: GetReviewsParams = {}): Promise<PaginatedList<Review>> {
    let list = [...this.reviews];
    if (params.rating) {
      list = list.filter((r) => r.rating === params.rating);
    }
    if (params.commentRequired) {
      list = list.filter((r) => Boolean(r.text?.trim()));
    }
    const limit = params.count ?? 24;
    return {
      items: list.slice(0, limit).map((r) => structuredClone(r)),
      pageInfo: { hasNextPage: false },
    };
  }

  public async getTransactions(count = 24): Promise<PaginatedList<Transaction>> {
    return {
      items: this.transactions.slice(0, count).map((t) => structuredClone(t)),
      pageInfo: { hasNextPage: false },
    };
  }

  public async getSbpBankMembers(): Promise<SbpBankMember[]> {
    return [
      { id: '100000000004', name: 'Тинькофф (Т-Банк)' },
      { id: '100000000111', name: 'Сбербанк' },
      { id: '100000000008', name: 'Альфа-Банк' },
    ];
  }

  public async getVerifiedCards(): Promise<VerifiedCard[]> {
    return [
      { id: 'card-demo-1', cardFirstSix: '220070', cardLastFour: '1234', cardType: 'MIR', isChosen: true },
    ];
  }

  public async requestWithdrawal(params: RequestWithdrawalParams): Promise<Transaction> {
    this.withdrawalRequests.push({ ...params });
    const tx: Transaction = {
      id: `tx-w-${crypto.randomUUID().slice(0, 8)}`,
      operation: TransactionOperations.WITHDRAW,
      direction: TransactionDirections.OUT,
      providerId: params.provider,
      status: TransactionStatuses.PENDING,
      value: params.value,
      createdAt: new Date().toISOString(),
      account: params.account,
    };
    this.transactions.unshift(tx);
    if (this.account.profile.balance) {
      this.account.profile.balance.withdrawable = Math.max(
        0,
        this.account.profile.balance.withdrawable - params.value,
      );
      this.account.profile.balance.available = this.account.profile.balance.withdrawable;
    }
    return structuredClone(tx);
  }

  public async removeTransaction(transactionId: string): Promise<Transaction> {
    const idx = this.transactions.findIndex((t) => t.id === transactionId);
    if (idx === -1) throw new Error(`Mock transaction not found: ${transactionId}`);
    const [removed] = this.transactions.splice(idx, 1);
    return structuredClone(removed);
  }

  public async subscribe(handler: PlayerokEventHandler): Promise<() => void> {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  public async close(): Promise<void> {
    this.handlers.clear();
  }

  // Simulation helpers
  public async emitEvent(event: PlayerokEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
    }
  }

  public async simulateNewMessage(chatId: string, buyer: UserProfile, text: string | null): Promise<ChatMessage> {
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = {
        id: chatId,
        type: ChatTypes.PM,
        status: ChatStatuses.FINISHED,
        users: [structuredClone(this.account.profile), buyer],
      };
      this.chats.set(chatId, chat);
    }
    const message: ChatMessage = {
      id: `msg-${crypto.randomUUID().slice(0, 8)}`,
      text,
      createdAt: new Date().toISOString(),
      user: buyer,
    };
    const list = this.messagesByChat.get(chatId) ?? [];
    list.push(message);
    this.messagesByChat.set(chatId, list);
    chat.lastMessage = message;

    await this.emitEvent({
      type: EventTypes.NEW_MESSAGE,
      chat: structuredClone(chat),
      message: structuredClone(message),
      timestamp: Date.now(),
    });
    return message;
  }

  public async simulateNewDeal(params: {
    dealId?: string;
    chatId?: string;
    buyer: UserProfile;
    itemId: string;
    markSold?: boolean;
  }): Promise<ItemDeal> {
    const item = this.items.get(params.itemId);
    if (!item) throw new Error(`Mock item not found: ${params.itemId}`);
    if (params.markSold !== false) {
      item.status = ItemStatuses.SOLD;
    }

    const chatId = params.chatId ?? `chat-${params.buyer.id}`;
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = {
        id: chatId,
        type: ChatTypes.PM,
        status: ChatStatuses.FINISHED,
        users: [structuredClone(this.account.profile), params.buyer],
      };
      this.chats.set(chatId, chat);
    }

    const deal: ItemDeal = {
      id: params.dealId ?? `deal-${crypto.randomUUID().slice(0, 8)}`,
      status: ItemDealStatuses.PAID,
      direction: ItemDealDirections.OUT,
      user: params.buyer,
      item: structuredClone(item),
      chatId,
      createdAt: new Date().toISOString(),
    };
    this.deals.set(deal.id, deal);

    await this.emitEvent({
      type: EventTypes.NEW_DEAL,
      chat: structuredClone(chat),
      deal: structuredClone(deal),
      timestamp: Date.now(),
    });
    await this.emitEvent({
      type: EventTypes.ITEM_PAID,
      chat: structuredClone(chat),
      deal: structuredClone(deal),
      timestamp: Date.now(),
    });
    return deal;
  }
}
