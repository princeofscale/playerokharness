import { z } from 'zod';

export const BoundItemSchema = z.object({
  id: z.string(),
  slug: z.string().optional(),
  name: z.string().optional(),
});

export type BoundItem = z.infer<typeof BoundItemSchema>;

export const ItemBindingSchema = z.object({
  items: z.array(BoundItemSchema).optional(),
  keyphrases: z.array(z.string()).optional(),
});

export type ItemBinding = z.infer<typeof ItemBindingSchema>;

export const BotConfigSchema = z.object({
  playerok: z.object({
    api: z.object({
      cookies: z.string().default(''),
      user_agent: z.string().default(''),
      proxy: z.string().default(''),
      requests_timeout: z.number().int().positive().default(30),
    }).default({ cookies: '', user_agent: '', proxy: '', requests_timeout: 30 }),
    watermark: z.object({
      enabled: z.boolean().default(true),
      value: z.string().default('©️ PlayerOK Harness'),
    }).default({ enabled: true, value: '©️ PlayerOK Harness' }),
    read_chat: z.boolean().default(true),
    auto_restore_items: z.object({
      sold: z.boolean().default(true),
      expired: z.boolean().default(false),
      all: z.boolean().default(true),
      free: z.boolean().default(true),
      premium: z.boolean().default(true),
      publish_status: z.enum(['last', 'free', 'premium']).default('last'),
      recreate: z.boolean().default(false),
    }).default({
      sold: true,
      expired: false,
      all: true,
      free: true,
      premium: true,
      publish_status: 'last',
      recreate: false,
    }),
    auto_complete_deals: z.object({
      enabled: z.boolean().default(false),
      all: z.boolean().default(true),
    }).default({ enabled: false, all: true }),
    blacklist: z.object({
      auto_refund: z.boolean().default(false),
    }).default({ auto_refund: false }),
    auto_bump_items: z.object({
      enabled: z.boolean().default(false),
      mode: z.enum(['interval', 'position']).default('interval'),
      interval: z.number().int().nonnegative().default(3600),
      position: z.number().int().nonnegative().default(10),
      cooldown: z.number().int().nonnegative().default(600),
      check_interval: z.number().int().positive().default(120),
      all: z.boolean().default(false),
      last_time: z.string().default(''),
      last_check_time: z.string().default(''),
      night: z.object({
        enabled: z.boolean().default(false),
        interval: z.number().int().nonnegative().default(14400),
        position: z.number().int().nonnegative().default(25),
        time_from: z.string().default('23:00'),
        time_to: z.string().default('08:00'),
      }).default({
        enabled: false,
        interval: 14400,
        position: 25,
        time_from: '23:00',
        time_to: '08:00',
      }),
    }).default({
      enabled: false,
      mode: 'interval',
      interval: 3600,
      position: 10,
      cooldown: 600,
      check_interval: 120,
      all: false,
      last_time: '',
      last_check_time: '',
      night: {
        enabled: false,
        interval: 14400,
        position: 25,
        time_from: '23:00',
        time_to: '08:00',
      },
    }),
    auto_withdrawal: z.object({
      enabled: z.boolean().default(false),
      interval: z.number().int().positive().default(86400),
      last_time: z.string().default(''),
      credentials_type: z.enum(['', 'card', 'sbp', 'usdt']).default(''),
      card_id: z.string().default(''),
      sbp_bank_id: z.string().default(''),
      sbp_phone_number: z.string().default(''),
      usdt_address: z.string().default(''),
    }).default({
      enabled: false,
      interval: 86400,
      last_time: '',
      credentials_type: '',
      card_id: '',
      sbp_bank_id: '',
      sbp_phone_number: '',
      usdt_address: '',
    }),
    notifications: z.object({
      enabled: z.boolean().default(true),
      chat_id: z.union([z.string(), z.number()]).default(''),
      events: z.object({
        new_user_message: z.boolean().default(true),
        new_system_message: z.boolean().default(true),
        new_deal: z.boolean().default(true),
        new_review: z.boolean().default(true),
        new_problem: z.boolean().default(true),
        deal_status_changed: z.boolean().default(true),
        item_restored: z.boolean().default(true),
        item_bumped: z.boolean().default(true),
        withdrawal_requested: z.boolean().default(true),
      }).default({
        new_user_message: true,
        new_system_message: true,
        new_deal: true,
        new_review: true,
        new_problem: true,
        deal_status_changed: true,
        item_restored: true,
        item_bumped: true,
        withdrawal_requested: true,
      }),
    }).default({
      enabled: true,
      chat_id: '',
      events: {
        new_user_message: true,
        new_system_message: true,
        new_deal: true,
        new_review: true,
        new_problem: true,
        deal_status_changed: true,
        item_restored: true,
        item_bumped: true,
        withdrawal_requested: true,
      },
    }),
  }).default({} as never),
  telegram: z.object({
    api: z.object({
      token: z.string().default(''),
      proxy: z.string().default(''),
      custom_api_url: z.string().default(''),
    }).default({ token: '', proxy: '', custom_api_url: '' }),
    bot: z.object({
      password: z.string().default(''),
      signed_users: z.array(z.number()).default([]),
    }).default({ password: '', signed_users: [] }),
  }).default({
    api: { token: '', proxy: '', custom_api_url: '' },
    bot: { password: '', signed_users: [] },
  }),
  updates: z.object({
    auto_update: z.boolean().default(true),
    notify: z.boolean().default(true),
  }).default({ auto_update: true, notify: true }),
  logs: z.object({
    max_file_size: z.number().positive().default(512),
  }).default({ max_file_size: 512 }),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;

export const MessageTemplateSchema = z.object({
  label: z.string(),
  enabled: z.boolean(),
  text: z.array(z.string()),
});

export type MessageTemplate = z.infer<typeof MessageTemplateSchema>;

export const MessagesSettingsSchema = z.record(z.string(), MessageTemplateSchema);
export type MessagesSettings = z.infer<typeof MessagesSettingsSchema>;

export const CustomCommandsSchema = z.record(z.string(), z.array(z.string()));
export type CustomCommandsSettings = z.infer<typeof CustomCommandsSchema>;

export const AutoDeliveryRuleSchema = ItemBindingSchema.extend({
  piece: z.boolean().default(false),
  goods: z.array(z.string()).optional(),
  message: z.array(z.string()).optional(),
});
export type AutoDeliveryRule = z.infer<typeof AutoDeliveryRuleSchema>;
export const AutoDeliveriesSchema = z.array(AutoDeliveryRuleSchema);

export const BindingEntrySchema = z.union([ItemBindingSchema, z.array(z.string())]);
export type BindingEntry = z.infer<typeof BindingEntrySchema>;

export const IncludeExcludeSchema = z.object({
  included: z.array(BindingEntrySchema).default([]),
  excluded: z.array(BindingEntrySchema).default([]),
});
export type IncludeExcludeSettings = z.infer<typeof IncludeExcludeSchema>;

export const FastReplySchema = z.object({
  name: z.string(),
  text: z.array(z.string()),
});
export type FastReply = z.infer<typeof FastReplySchema>;
export const FastRepliesSchema = z.array(FastReplySchema);

export const DataReplacementRuleSchema = ItemBindingSchema.extend({
  enabled: z.boolean().default(true),
  separator: z.string().default(':'),
  data: z.array(z.string()).default([]),
});
export type DataReplacementRule = z.infer<typeof DataReplacementRuleSchema>;
export const DataReplacementSchema = z.array(DataReplacementRuleSchema);

export const BlacklistEntrySchema = z.object({
  reason: z.string().default(''),
  date: z.string(),
  by: z.string().default('вручную'),
});
export type BlacklistEntry = z.infer<typeof BlacklistEntrySchema>;

export const BlacklistSettingsSchema = z.object({
  users: z.record(z.string(), BlacklistEntrySchema).default({}),
});
export type BlacklistSettings = z.infer<typeof BlacklistSettingsSchema>;

// Runtime data schemas
export const CachedOrderSchema = z.object({
  id: z.string(),
  price: z.number(),
  status: z.string(),
  date: z.string(),
  item_id: z.string(),
  item_name: z.string(),
});
export type CachedOrder = z.infer<typeof CachedOrderSchema>;

export const CachedOrdersSchema = z.record(z.string(), CachedOrderSchema);
export type CachedOrders = z.infer<typeof CachedOrdersSchema>;

export const BumpedItemsSchema = z.record(z.string(), z.string());
export type BumpedItems = z.infer<typeof BumpedItemsSchema>;

export const AccessRequestSchema = z.object({
  time: z.number(),
  username: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});
export type AccessRequest = z.infer<typeof AccessRequestSchema>;
export const AccessRequestsSchema = z.record(z.string(), AccessRequestSchema);
export type AccessRequests = z.infer<typeof AccessRequestsSchema>;

export const OwnerLinkSchema = z.object({
  code: z.string().optional(),
});
export type OwnerLink = z.infer<typeof OwnerLinkSchema>;

export const BootMarkerSchema = z.object({
  action: z.string().optional(),
  chat_id: z.union([z.number(), z.string()]).optional(),
  message_id: z.number().nullable().optional(),
  timestamp: z.number().optional(),
});
export type BootMarker = z.infer<typeof BootMarkerSchema>;

export const IdempotencyStoreSchema = z.object({
  delivered_deals: z.record(z.string(), z.string()).default({}),
  completed_deals: z.record(z.string(), z.string()).default({}),
});
export type IdempotencyStore = z.infer<typeof IdempotencyStoreSchema>;

export const DEFAULT_CONFIG: BotConfig = {
  playerok: {
    api: {
      cookies: '',
      user_agent: '',
      proxy: '',
      requests_timeout: 30,
    },
    watermark: {
      enabled: true,
      value: '©️ PlayerOK Harness',
    },
    read_chat: true,
    auto_restore_items: {
      sold: true,
      expired: false,
      all: true,
      free: true,
      premium: true,
      publish_status: 'last',
      recreate: false,
    },
    auto_complete_deals: {
      enabled: false,
      all: true,
    },
    blacklist: {
      auto_refund: false,
    },
    auto_bump_items: {
      enabled: false,
      mode: 'interval',
      interval: 3600,
      position: 10,
      cooldown: 600,
      check_interval: 120,
      all: false,
      last_time: '',
      last_check_time: '',
      night: {
        enabled: false,
        interval: 14400,
        position: 25,
        time_from: '23:00',
        time_to: '08:00',
      },
    },
    auto_withdrawal: {
      enabled: false,
      interval: 86400,
      last_time: '',
      credentials_type: '',
      card_id: '',
      sbp_bank_id: '',
      sbp_phone_number: '',
      usdt_address: '',
    },
    notifications: {
      enabled: true,
      chat_id: '',
      events: {
        new_user_message: true,
        new_system_message: true,
        new_deal: true,
        new_review: true,
        new_problem: true,
        deal_status_changed: true,
        item_restored: true,
        item_bumped: true,
        withdrawal_requested: true,
      },
    },
  },
  telegram: {
    api: {
      token: '',
      proxy: '',
      custom_api_url: '',
    },
    bot: {
      password: '',
      signed_users: [],
    },
  },
  updates: {
    auto_update: true,
    notify: true,
  },
  logs: {
    max_file_size: 512,
  },
};

export const DEFAULT_MESSAGES: MessagesSettings = {
  first_message: {
    label: '👋 Приветствие',
    enabled: true,
    text: [
      '👋 Привет, {user.username}, я бот-помощник PlayerOK Harness',
      '',
      '💡 Если вы хотите поговорить с продавцом, напишите команду !продавец, чтобы я пригласил его в этот диалог',
    ],
  },
  cmd_error: {
    label: '❌ Ошибка команды',
    enabled: true,
    text: ['❌ При вводе команды произошла ошибка: {error}'],
  },
  cmd_seller: {
    label: '💬 Вызов продавца',
    enabled: true,
    text: ['💬 Продавец был вызван в этот чат. Ожидайте, пока он подключится к диалогу...'],
  },
  new_deal: {
    label: '📋 Новая сделка',
    enabled: false,
    text: [
      '📋 Спасибо за покупку «{item.name}» за {item.price}₽',
      '',
      'Меня сейчас может не быть на месте, чтобы позвать его, используйте команду !продавец',
    ],
  },
  deal_sent: {
    label: '✅ Товар отправлен',
    enabled: false,
    text: [
      '✅ Я подтвердил выполнение вашего заказа! Если вы не получили купленный товар - напишите это в чате',
    ],
  },
  deal_confirmed: {
    label: '🌟 Сделка подтверждена',
    enabled: false,
    text: [
      '🌟 Спасибо за успешную сделку. Буду рад, если оставите отзыв. Жду вас в своём магазине в следующий раз, удачи!',
    ],
  },
  deal_refunded: {
    label: '📦 Возврат сделки',
    enabled: false,
    text: [
      '📦 Заказ был возвращён. Надеюсь, эта сделка не принесла вам неудобств. Жду вас в своём магазине в следующий раз, удачи!',
    ],
  },
  deal_has_problem: {
    label: '🙏 Проблема в сделке',
    enabled: false,
    text: [
      '🙏 Пожалуйста, напишите, с чем у вас возникли проблемы, чтобы я смог вам помочь.',
      '',
      '❗ Если меня нет в сети, позовите командой !продавец',
    ],
  },
  new_review: {
    label: '✨ Спасибо за отзыв',
    enabled: false,
    text: [
      '✨ Спасибо за {review_rating}⭐ отзыв! Надеюсь, вам понравилось качество выполненной работы',
    ],
  },
  blacklist_deal_refunded: {
    label: '🚫 Возврат сделки из ЧС',
    enabled: true,
    text: ['🚫 Вы находитесь в чёрном списке продавца, поэтому сделка была возвращена'],
  },
};
