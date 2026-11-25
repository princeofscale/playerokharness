import { z } from '@pkh/core';

/**
 * Response-contract schemas for the PlayerOK GraphQL transport.
 *
 * `GraphQLPlayerokTransport` maps raw GraphQL payloads into domain models with
 * defensive fallbacks (`String(x ?? '')`, `Number(n ?? 0)`, ...), so a field that
 * PlayerOK renames or removes degrades silently into an empty value with no signal.
 * These schemas describe exactly the fields the mapping functions
 * (`mapUser`/`mapChat`/`mapItem`/`mapDeal`/`mapMessage`/`mapTransaction`) read.
 *
 * Every object is loose (`z.looseObject`): unknown NEW fields are always accepted,
 * so only a missing or mistyped field the transport actually consumes is reported.
 * Schemas never transform or default values - the guard validates and hands the raw
 * payload back, so the returned domain shape is unchanged.
 */

/** Records one contract drift observed at the GraphQL boundary. */
export interface ContractIssue {
  /** GraphQL operation (or WS payload marker) the drift was observed in. */
  op: string;
  /** First 5 Zod issue paths, dotted (e.g. `items.edges.0.node.id`). */
  paths: string[];
  /** Total number of Zod issues reported for the payload. */
  issueCount: number;
  /** ISO timestamp of the observation. */
  at: string;
}

const fileNodeSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  filename: z.string().nullish(),
  mime: z.string().nullish(),
});

export type FileNode = z.infer<typeof fileNodeSchema>;

const balanceNodeSchema = z.looseObject({
  id: z.string().nullish(),
  value: z.number(),
  frozen: z.number().nullish(),
  available: z.number().nullish(),
  withdrawable: z.number().nullish(),
  pendingIncome: z.number().nullish(),
});

export type BalanceNode = z.infer<typeof balanceNodeSchema>;

const statsCounterSchema = z.looseObject({
  total: z.number(),
  finished: z.number(),
});

/** Shape of `user.stats` as consumed by `AccountProfile.stats`. */
export const statsNodeSchema = z.looseObject({
  items: statsCounterSchema,
  deals: z.looseObject({
    incoming: statsCounterSchema,
    outgoing: statsCounterSchema,
  }),
});

export type StatsNode = z.infer<typeof statsNodeSchema>;

/**
 * Nested `user.profile` object. `getAccount` merges it into the viewer profile,
 * so it carries the profile bits the transport reads (avatar, rating, review
 * counter, registration/banned flags, balance and stats).
 */
export const profileNodeSchema = z.looseObject({
  id: z.string().nullish(),
  username: z.string().nullish(),
  nickname: z.string().nullish(),
  avatarURL: z.string().nullish(),
  avatarUrl: z.string().nullish(),
  rating: z.number().nullish(),
  testimonialCounter: z.number().nullish(),
  reviewsCount: z.number().nullish(),
  registrationDate: z.string().nullish(),
  isBanned: z.boolean().nullish(),
  balance: balanceNodeSchema.nullish(),
  stats: statsNodeSchema.nullish(),
});

export type ProfileNode = z.infer<typeof profileNodeSchema>;

/**
 * Raw PlayerOK user node. `id` is the only hard requirement (`mapUser` keys every
 * domain object on it); the remaining fields are the ones `mapUser` and
 * `getAccount` read, plus the full profile bits they fall back to.
 */
export const userNodeSchema = z.looseObject({
  __typename: z.string().nullish(),
  id: z.string(),
  username: z.string().nullish(),
  nickname: z.string().nullish(),
  role: z.string().nullish(),
  avatarURL: z.string().nullish(),
  avatarUrl: z.string().nullish(),
  isOnline: z.boolean().nullish(),
  isBlocked: z.boolean().nullish(),
  isBanned: z.boolean().nullish(),
  rating: z.number().nullish(),
  testimonialCounter: z.number().nullish(),
  reviewsCount: z.number().nullish(),
  supportChatId: z.string().nullish(),
  systemChatId: z.string().nullish(),
  createdAt: z.string().nullish(),
  registrationDate: z.string().nullish(),
  balance: balanceNodeSchema.nullish(),
  stats: statsNodeSchema.nullish(),
  profile: profileNodeSchema.nullish(),
});

export type UserNode = z.infer<typeof userNodeSchema>;

const dataFieldNodeSchema = z.looseObject({
  id: z.string(),
  label: z.string().nullish(),
  type: z.string().nullish(),
  value: z.string(),
  hidden: z.boolean().nullish(),
});

export type DataFieldNode = z.infer<typeof dataFieldNodeSchema>;

/**
 * Raw item node. The fields `mapItem` copies are typed strictly; `slug`, `name`,
 * `price` and `rawPrice` are load-bearing (re-publishing uses them), so they are
 * required rather than silently defaulted to `''`/`0`.
 */
export const itemNodeSchema = z.looseObject({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  price: z.number(),
  rawPrice: z.number().nullish(),
  priority: z.string().nullish(),
  status: z.string().nullish(),
  sequence: z.number().nullish(),
  mayBePublished: z.boolean().nullish(),
  user: userNodeSchema.nullish(),
  category: z
    .looseObject({
      id: z.string(),
      name: z.string().optional(),
      slug: z.string().optional(),
    })
    .nullish(),
  obtainingType: z
    .looseObject({
      id: z.string(),
      name: z.string().optional(),
    })
    .nullish(),
  attributes: z.record(z.string(), z.unknown()).nullish(),
  dataFields: z.array(dataFieldNodeSchema).nullish(),
  attachments: z.array(fileNodeSchema).nullish(),
});

export type ItemNode = z.infer<typeof itemNodeSchema>;

/**
 * Raw review/testimonial node. Used both for the standalone reviews list and for
 * the `testimonial` embedded in a deal.
 */
export const reviewNodeSchema = z.looseObject({
  id: z.string(),
  status: z.string().nullish(),
  rating: z.number(),
  text: z.string().nullish(),
  createdAt: z.string().nullish(),
  creator: userNodeSchema.nullish(),
  user: userNodeSchema.nullish(),
  dealId: z.string().nullish(),
});

export type ReviewNode = z.infer<typeof reviewNodeSchema>;

/**
 * Deal shape shared by the standalone deal envelope and embedded deal references
 * (`message.deal`, `chat.lastMessage.deal`). Embedded references are partial: the
 * transport re-fetches the full deal before acting on it.
 */
const dealCommonShape = {
  id: z.string(),
  status: z.string().nullish(),
  direction: z.string().nullish(),
  createdAt: z.string().nullish(),
  completedAt: z.string().nullish(),
  hasProblem: z.boolean().nullish(),
  commentFromBuyer: z.string().nullish(),
  chat: z.looseObject({ id: z.string() }).nullish(),
  testimonial: reviewNodeSchema.nullish(),
  review: reviewNodeSchema.nullish(),
};

export const embeddedDealNodeSchema = z.looseObject({
  ...dealCommonShape,
  user: userNodeSchema.nullish(),
  item: itemNodeSchema.nullish(),
});

export type EmbeddedDealNode = z.infer<typeof embeddedDealNodeSchema>;

/** Deal node fetched directly (`deal`, `getDeals`, `updateDeal`, ...). */
export const dealNodeSchema = z.looseObject({
  ...dealCommonShape,
  user: userNodeSchema,
  item: itemNodeSchema,
});

export type DealNode = z.infer<typeof dealNodeSchema>;

/**
 * Shared message shape. `getChatMessages` and the WS subscription both consume it.
 * The mapper reads `user`/`images`/`file`; `byUser`/`attachments` are the alternate
 * spellings PlayerOK ships elsewhere, accepted here so they are never false alarms.
 */
const chatMessageCommonShape = {
  id: z.string(),
  text: z.string().nullish(),
  createdAt: z.string(),
  isRead: z.boolean().nullish(),
  user: userNodeSchema,
  byUser: userNodeSchema.nullish(),
  images: z.array(fileNodeSchema).nullish(),
  attachments: z.array(fileNodeSchema).nullish(),
  file: fileNodeSchema.nullish(),
  deal: embeddedDealNodeSchema.nullish(),
};

export const chatMessageNodeSchema = z.looseObject(chatMessageCommonShape);

/**
 * `createChatMessage` response node. `mapMessage` runs directly on the mutation
 * result and copies `text` straight through, so here the key must be present: a
 * null text is legitimate for an image-only message, a missing one means the
 * field was renamed and would otherwise degrade to an empty message silently.
 */
const sentMessageNodeSchema = z.looseObject({
  ...chatMessageCommonShape,
  text: z.string().nullable(),
});

export type ChatMessageNode = z.infer<typeof chatMessageNodeSchema>;

/** Raw chat node. `participants`/`users` are both accepted, as in `mapChat`. */
export const chatNodeSchema = z.looseObject({
  id: z.string(),
  type: z.string().nullish(),
  status: z.string().nullish(),
  unreadMessagesCounter: z.number().nullish(),
  participants: z.array(userNodeSchema).nullish(),
  users: z.array(userNodeSchema).nullish(),
  lastMessage: chatMessageNodeSchema.nullish(),
});

export type ChatNode = z.infer<typeof chatNodeSchema>;

/** Raw item priority status node. */
export const priorityStatusNodeSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  price: z.number(),
  type: z.string(),
  period: z.number().nullish(),
});

export type PriorityStatusNode = z.infer<typeof priorityStatusNodeSchema>;

/** Raw transaction node. `props.userData.account` is the withdrawal account fallback. */
export const transactionNodeSchema = z.looseObject({
  id: z.string(),
  operation: z.string(),
  direction: z.string(),
  providerId: z.string().nullish(),
  status: z.string(),
  value: z.number(),
  fee: z.number().nullish(),
  createdAt: z.string(),
  account: z.string().nullish(),
  props: z
    .looseObject({
      userData: z.looseObject({ account: z.string().nullish() }).nullish(),
    })
    .nullish(),
});

export type TransactionNode = z.infer<typeof transactionNodeSchema>;

const pageInfoSchema = z.looseObject({
  startCursor: z.string().nullish(),
  endCursor: z.string().nullish(),
  hasPreviousPage: z.boolean().nullish(),
  hasNextPage: z.boolean().nullish(),
});

const chatEdgeSchema = z.looseObject({ node: chatNodeSchema });
const messageEdgeSchema = z.looseObject({ node: chatMessageNodeSchema });
const itemEdgeSchema = z.looseObject({ node: itemNodeSchema });
const dealEdgeSchema = z.looseObject({ node: dealNodeSchema });
const reviewEdgeSchema = z.looseObject({ node: reviewNodeSchema });
const transactionEdgeSchema = z.looseObject({ node: transactionNodeSchema });

/** `viewer` (POST, used by `getAccount`). */
export const viewerPayloadSchema = z.looseObject({
  viewer: z
    .looseObject({
      id: z.string(),
      username: z.string(),
      email: z.string().nullish(),
      role: z.string().nullish(),
      supportChatId: z.string().nullish(),
      systemChatId: z.string().nullish(),
      unreadChatsCounter: z.number().nullish(),
      isBlocked: z.boolean().nullish(),
      isBlockedFor: z.string().nullish(),
      createdAt: z.string().nullish(),
      lastItemCreatedAt: z.string().nullish(),
      hasFrozenBalance: z.boolean().nullish(),
      hasConfirmedPhoneNumber: z.boolean().nullish(),
      canPublishItems: z.boolean().nullish(),
      balance: balanceNodeSchema.nullish(),
      profile: profileNodeSchema.nullish(),
    })
    .nullable(),
});

/** `user` persisted query. Null user is legitimate (unknown id), a renamed key is not. */
export const userPayloadSchema = z.looseObject({
  user: userNodeSchema.nullable(),
});

/** `userChats` persisted query. */
export const chatsPayloadSchema = z.looseObject({
  chats: z.looseObject({
    edges: z.array(chatEdgeSchema),
    pageInfo: pageInfoSchema.nullish(),
  }),
});

/** `chat` persisted query. */
export const chatPayloadSchema = z.looseObject({
  chat: chatNodeSchema.nullable(),
});

/** `chatMessages` persisted query. */
export const chatMessagesPayloadSchema = z.looseObject({
  chatMessages: z.looseObject({
    edges: z.array(messageEdgeSchema),
    pageInfo: pageInfoSchema.nullish(),
  }),
});

/** `items` persisted query. */
export const itemsPayloadSchema = z.looseObject({
  items: z.looseObject({
    edges: z.array(itemEdgeSchema),
    pageInfo: pageInfoSchema.nullish(),
  }),
});

/** `item` persisted query. */
export const itemPayloadSchema = z.looseObject({
  item: itemNodeSchema.nullable(),
});

/** `itemPriorityStatuses` persisted query. */
export const itemPriorityStatusesPayloadSchema = z.looseObject({
  itemPriorityStatuses: z.array(priorityStatusNodeSchema),
});

/** `deals` persisted query. */
export const dealsPayloadSchema = z.looseObject({
  deals: z.looseObject({
    edges: z.array(dealEdgeSchema),
    pageInfo: pageInfoSchema.nullish(),
  }),
});

/** `deal` persisted query. */
export const dealPayloadSchema = z.looseObject({
  deal: dealNodeSchema.nullable(),
});

/** `testimonials` persisted query (the reviews list). */
export const reviewsPayloadSchema = z.looseObject({
  testimonials: z.looseObject({
    edges: z.array(reviewEdgeSchema),
    pageInfo: pageInfoSchema.nullish(),
  }),
});

/** `transactions` persisted query. */
export const transactionsPayloadSchema = z.looseObject({
  transactions: z.looseObject({
    edges: z.array(transactionEdgeSchema),
    pageInfo: pageInfoSchema.nullish(),
  }),
});

/*
 * Mutation envelopes.
 *
 * Every mutation answers with the same node shape its query counterpart returns,
 * and the transport maps that node immediately (`mapItem`/`mapDeal`/
 * `mapMessage`/`mapTransaction`), so a renamed response key or a dropped consumed
 * field used to degrade into ''/0/null with no signal. The envelope requires the
 * operation key: `nullable()` (not `nullish()`) tolerates a null node - mapped
 * best-effort - while a missing or renamed key is reported as a `ContractIssue`.
 */

/** `updateDeal` - the updated deal, mapped by `mapDeal`. */
export const updateDealPayloadSchema = z.looseObject({
  updateDeal: dealNodeSchema.nullable(),
});

/** `reportDealProblem` - the flagged deal; same node as `updateDeal`. */
export const reportDealProblemPayloadSchema = z.looseObject({
  reportDealProblem: dealNodeSchema.nullable(),
});

/** `publishItem` - the re-published item, mapped by `mapItem`. */
export const publishItemPayloadSchema = z.looseObject({
  publishItem: itemNodeSchema.nullable(),
});

/** `createItem` - the created item; same selected fields as `publishItem`. */
export const createItemPayloadSchema = z.looseObject({
  createItem: itemNodeSchema.nullable(),
});

/** `updateItem` - the edited item plus the `dataFields` `mapItem` copies. */
export const updateItemPayloadSchema = z.looseObject({
  updateItem: itemNodeSchema.nullable(),
});

/** `increaseItemPriorityStatus` - the bumped item. */
export const increaseItemPriorityStatusPayloadSchema = z.looseObject({
  increaseItemPriorityStatus: itemNodeSchema.nullable(),
});

/** `requestWithdrawal` - `mapTransaction` keys the created transaction on `id`. */
export const requestWithdrawalPayloadSchema = z.looseObject({
  requestWithdrawal: transactionNodeSchema.nullable(),
});

/** `removeTransaction` - the cancelled transaction. */
export const removeTransactionPayloadSchema = z.looseObject({
  removeTransaction: transactionNodeSchema.nullable(),
});

/** `createChatMessage` - the sent message echoed back and mapped by `mapMessage`. */
export const createChatMessagePayloadSchema = z.looseObject({
  createChatMessage: sentMessageNodeSchema.nullable(),
});

/**
 * WS `next` payload. Exactly one known subscription key is expected per frame;
 * if PlayerOK renames `chatMessageCreated` (or drops every key we know) the
 * refinement reports it instead of the frame being silently ignored.
 */
export const wsNextPayloadSchema = z
  .looseObject({
    chatMessageCreated: chatMessageNodeSchema.nullish(),
    chatUpdated: chatNodeSchema.nullish(),
    userUpdated: z
      .looseObject({
        id: z.string().nullish(),
        unreadChatsCounter: z.number().nullish(),
      })
      .nullish(),
  })
  .refine(
    (payload) =>
      payload.chatMessageCreated != null ||
      payload.chatUpdated != null ||
      payload.userUpdated != null,
    { message: 'no known subscription payload key present' },
  );

export type WsNextPayload = z.infer<typeof wsNextPayloadSchema>;

/**
 * createChatMessage depends on the temporary-store upload: a null/renamed node there used
 * to crash with "Cannot read properties of null (reading 'id')" inside sendMessage.
 */
export const uploadChatImagePayloadSchema = z.looseObject({
  uploadChatImageIntoTemporaryStore: z.looseObject({ id: z.string() }).nullable(),
});
