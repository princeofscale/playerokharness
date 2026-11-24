import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@pkh/core': path.join(rootDir, 'packages/core/dist/index.js'),
      '@pkh/adapter': path.join(rootDir, 'packages/playerok/dist/index.js'),
      '@pkh/plugin-automation': path.join(rootDir, 'packages/plugin-automation/dist/index.js'),
      '@pkh/plugin-telegram': path.join(rootDir, 'packages/plugin-telegram/dist/index.js'),
      '@pkh/app': path.join(rootDir, 'packages/app/dist/index.js'),
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
