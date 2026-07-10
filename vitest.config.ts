import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(process.env.FABEL_LIVE ? [] : ['test/live/**'])],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
