import type {
  ChatInitializedEvent,
  DealEvent,
  GitHubRelease,
  LoadedPluginRecord,
  NewMessageEvent,
  NotificationPayload,
  SellerCallPayload,
  SetupProblem,
} from './types/models.js';
import type { StorageService } from './services/storage.js';
import type { LogSinkService } from './services/log-sink.js';
import type { LockService } from './services/lock.js';
import type { AccessService } from './services/access.js';
import type { BlacklistService } from './services/blacklist.js';
import type { PluginManagerService } from './services/plugin-manager.js';
import type { BootReportService } from './services/boot-report.js';
import type { UpdaterService } from './services/updater.js';

export interface PlayerokCoreEvents {
  // Bot lifecycle
  'bot/init'(): void | Promise<void>;
  'bot/ready'(): void | Promise<void>;
  'bot/shutdown'(): void | Promise<void>;
  'bot/setup-mode'(problem: SetupProblem): void | Promise<void>;
  'bot/module-enabled'(record: LoadedPluginRecord): void | Promise<void>;
  'bot/module-disabled'(record: LoadedPluginRecord): void | Promise<void>;
  'update/available'(release: GitHubRelease): void | Promise<void>;

  // PlayerOK events (1:1 with EventTypes)
  'playerok/chat-initialized'(event: ChatInitializedEvent): void | Promise<void>;
  'playerok/new-message'(event: NewMessageEvent): void | Promise<void>;
  'playerok/new-deal'(event: DealEvent): void | Promise<void>;
  'playerok/new-review'(event: DealEvent): void | Promise<void>;
  'playerok/deal-confirmed'(event: DealEvent): void | Promise<void>;
  'playerok/deal-confirmed-automatically'(event: DealEvent): void | Promise<void>;
  'playerok/deal-rolled-back'(event: DealEvent): void | Promise<void>;
  'playerok/deal-has-problem'(event: DealEvent): void | Promise<void>;
  'playerok/deal-problem-resolved'(event: DealEvent): void | Promise<void>;
  'playerok/deal-status-changed'(event: DealEvent): void | Promise<void>;
  'playerok/item-paid'(event: DealEvent): void | Promise<void>;
  'playerok/item-sent'(event: DealEvent): void | Promise<void>;

  // Cross-plugin notifications & automation hooks
  'notify/log'(payload: NotificationPayload): void | Promise<void>;
  'notify/call-seller'(payload: SellerCallPayload): void | Promise<void>;
  'item/restored'(info: {
    itemId: string;
    oldItemId?: string;
    slug: string;
    name: string;
    isPremium: boolean;
    recreated: boolean;
    dataReplacedRemaining?: number;
    oldRemoved: boolean;
  }): void | Promise<void>;
  'item/bumped'(info: {
    itemId: string;
    slug: string;
    name: string;
    previousPosition?: number | null;
    reason?: string;
  }): void | Promise<void>;
  'withdrawal/requested'(info: {
    transactionId: string;
    amount: number;
    provider: string;
  }): void | Promise<void>;
  'deal/blacklisted'(info: {
    event: DealEvent;
    reason: string;
    refunded: boolean;
  }): void | Promise<void>;
}

declare module 'cordis' {
  interface Context {
    storage: StorageService;
    logSink: LogSinkService;
    lock: LockService;
    access: AccessService;
    blacklist: BlacklistService;
    plugins: PluginManagerService;
    bootReport: BootReportService;
    updater: UpdaterService;
  }

  interface Events extends PlayerokCoreEvents {}
}
