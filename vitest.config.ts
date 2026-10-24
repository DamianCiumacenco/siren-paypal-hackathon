import { configDefaults, defineConfig } from 'vitest/config';

// `npm test`: unit/route tests only. The live e2e suite (test/e2e) runs via `npm run test:e2e`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/e2e/**'],
  },
});
