import type { Context } from '@pkh/core';
import { ordersCachePlugin } from './plugins/orders-cache.js';
import { blacklistPlugin } from './plugins/blacklist.js';
import { messagesPlugin } from './plugins/messages.js';
import { autoDeliveryPlugin } from './plugins/auto-delivery.js';
import { autoCompletePlugin } from './plugins/auto-complete.js';
import { AutoRestoreService, type AutoRestoreConfig } from './plugins/auto-restore.js';
import { AutoBumpService, type AutoBumpConfig } from './plugins/auto-bump.js';
import { AutoWithdrawalService, type AutoWithdrawalConfig } from './plugins/auto-withdrawal.js';
import { notificationsPlugin } from './plugins/notifications.js';

export * from './plugins/orders-cache.js';
export * from './plugins/blacklist.js';
export * from './plugins/messages.js';
export * from './plugins/auto-delivery.js';
export * from './plugins/auto-complete.js';
export * from './plugins/auto-restore.js';
export * from './plugins/auto-bump.js';
export * from './plugins/auto-withdrawal.js';
export * from './plugins/notifications.js';

export interface AutomationBundleConfig {
  enableTimers?: boolean;
  restore?: AutoRestoreConfig;
  bump?: AutoBumpConfig;
  withdrawal?: AutoWithdrawalConfig;
}

/**
 * Mounts all standard PlayerOK Harness automation plugins into a Cordis Context.
 */
export const automationBundle = {
  name: 'automation-bundle',
  inject: ['storage', 'blacklist', 'playerok'],
  apply(ctx: Context, config: AutomationBundleConfig = {}): void {
    const enableTimers = config.enableTimers ?? true;

    ctx.use(ordersCachePlugin);
    ctx.use(blacklistPlugin);
    ctx.use(messagesPlugin);
    ctx.use(autoDeliveryPlugin);
    ctx.use(autoCompletePlugin);
    ctx.use(AutoRestoreService, { enableTimer: enableTimers, ...config.restore });
    ctx.use(AutoBumpService, { enableTimer: enableTimers, ...config.bump });
    ctx.use(AutoWithdrawalService, { enableTimer: enableTimers, ...config.withdrawal });
    ctx.use(notificationsPlugin);
  },
};
