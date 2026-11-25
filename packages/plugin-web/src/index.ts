import type { Context } from '@pkh/core';
import { type WebDashboardConfig, WebDashboardService } from './service.js';

export * from './analytics.js';
export * from './audit.js';
export * from './metrics.js';
export * from './render.js';
export * from './service.js';

/**
 * Plain Cordis component wrapper, so the dashboard can be mounted from a plugin
 * manifest or a bundle without importing the Service class directly.
 */
export const webDashboardPlugin = {
  name: 'pkh:web',
  inject: ['storage'],
  apply(ctx: Context, config: WebDashboardConfig = {}): void {
    ctx.use(WebDashboardService, config);
  },
};
