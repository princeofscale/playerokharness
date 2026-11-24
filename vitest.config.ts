import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@playerok/core': path.join(rootDir, 'packages/core/dist/index.js'),
      '@playerok/adapter': path.join(rootDir, 'packages/playerok/dist/index.js'),
      '@playerok/plugin-automation': path.join(rootDir, 'packages/plugin-automation/dist/index.js'),
      '@playerok/plugin-telegram': path.join(rootDir, 'packages/plugin-telegram/dist/index.js'),
      '@playerok/app': path.join(rootDir, 'packages/app/dist/index.js'),
      ws: path.join(rootDir, 'packages/playerok/node_modules/ws/wrapper.mjs'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 15000,
  },
});
