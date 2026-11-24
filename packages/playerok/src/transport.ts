import type {
  AccountInfo,
  Chat,
  ChatMessage,
  DataField,
  ItemDeal,
  ItemDealDirections,
  ItemDealStatuses,
  ItemPriorityStatus,
  ItemProfile,
  ItemStatuses,
  MyItem,
  PaginatedList,
  PlayerokEvent,
  Review,
  SbpBankMember,
  Transaction,
  TransactionProviderIds,
  UserProfile,
  VerifiedCard,
} from '@playerok/core';

export interface BinaryUpload {
  filename: string;
  data: Buffer;
  contentType?: string;
}

export interface SendMessageParams {
  chatId: string;
  text?: string | null;
  images?: BinaryUpload[];
  markChatAsRead?: boolean;
}

export interface GetMyItemsParams {
  afterCursor?: string | null;
  statuses?: ItemStatuses[];
  gameId?: string | null;
  categoryId?: string | null;
  obtainingTypeId?: string | null;
  count?: number;
}

export interface CreateItemParams {
  gameCategoryId: string;
  obtainingTypeId: string;
  name: string;
  price: number;
  description: string;
  options?: Record<string, unknown>;
  dataFields?: DataField[];
  attachments?: BinaryUpload[];
}

export interface UpdateItemParams {
  name?: string;
  price?: number;
  description?: string;
  dataFields?: DataField[];
}

export interface GetDealsParams {
  afterCursor?: string | null;
  statuses?: ItemDealStatuses[];
  direction?: ItemDealDirections;
  count?: number;
}

export interface GetReviewsParams {
  count?: number;
  afterCursor?: string | null;
  rating?: number | null;
  commentRequired?: boolean;
}

export interface RequestWithdrawalParams {
  provider: TransactionProviderIds;
  account: string;
  value: number;
  sbpBankMemberId?: string | null;
}

export type PlayerokEventHandler = (event: PlayerokEvent) => void | Promise<void>;

export interface PlayerokTransport {
  readonly kind: 'mock' | 'graphql' | string;

  getAccount(): Promise<AccountInfo>;
  getUser(userId: string): Promise<UserProfile>;

  getChats(count?: number, afterCursor?: string | null): Promise<PaginatedList<Chat>>;
  getChat(chatId: string): Promise<Chat>;
  getChatMessages(chatId: string, count?: number): Promise<ChatMessage[]>;
  markChatAsRead(chatId: string): Promise<void>;
  sendMessage(params: SendMessageParams): Promise<ChatMessage>;
  downloadFile(url: string): Promise<Buffer>;

  getMyItems(params?: GetMyItemsParams): Promise<PaginatedList<ItemProfile>>;
  getItem(ref: { id?: string; slug?: string }): Promise<MyItem>;
  getItemPriorityStatuses(itemId: string, rawPrice: number): Promise<ItemPriorityStatus[]>;
  increaseItemPriorityStatus(itemId: string, priorityStatusId: string): Promise<MyItem>;
  publishItem(itemId: string, priorityStatusId: string): Promise<MyItem>;
  createItem(params: CreateItemParams): Promise<MyItem>;
  updateItem(itemId: string, params: UpdateItemParams): Promise<MyItem>;
  removeItem(itemId: string): Promise<boolean>;

  getDeals(params?: GetDealsParams): Promise<PaginatedList<ItemDeal>>;
  getDeal(dealId: string): Promise<ItemDeal>;
  updateDeal(dealId: string, status: ItemDealStatuses): Promise<ItemDeal>;
  reportDealProblem(dealId: string, description: string, problemTypeId: string): Promise<ItemDeal>;

  getReviews(params?: GetReviewsParams): Promise<PaginatedList<Review>>;
  getTransactions(count?: number, afterCursor?: string | null): Promise<PaginatedList<Transaction>>;
  getSbpBankMembers(): Promise<SbpBankMember[]>;
  getVerifiedCards(): Promise<VerifiedCard[]>;
  requestWithdrawal(params: RequestWithdrawalParams): Promise<Transaction>;
  removeTransaction(transactionId: string): Promise<Transaction>;

  subscribe(handler: PlayerokEventHandler): Promise<() => void>;
  close(): Promise<void>;
}
