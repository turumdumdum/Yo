import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // All files share one database, so run them one at a time.
    fileParallelism: false,
  },
});
