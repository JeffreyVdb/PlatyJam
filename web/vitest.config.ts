import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so the PWA plugin never runs under test.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
