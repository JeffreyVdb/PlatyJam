import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so the PWA plugin never runs under test.
export default defineConfig({
  test: {
    environment: 'jsdom',
    // Script tests run under Node: they start with `// @vitest-environment node`.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
