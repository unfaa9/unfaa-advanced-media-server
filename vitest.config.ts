import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: {
      DATABASE_URL: 'postgresql://unused@localhost/unused',
      STORAGE_PATH: './.data-test',
      LOG_LEVEL: 'silent',
    },
    testTimeout: 30_000,
  },
});
