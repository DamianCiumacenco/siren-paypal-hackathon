import { defineConfig } from 'vitest/config';

// `npm run test:e2e`: the 7 SCOPE success criteria against the LIVE deployment
// (E2E_BASE_URL, default https://siren-5brb.onrender.com). One file at a time, in order:
// they share one LLM quota and one production server.
export default defineConfig({
  test: {
    include: ['test/e2e/criterion-*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 300_000,
    hookTimeout: 300_000,
    retry: 0,
    allowOnly: false, // a stray .only would silently skip criteria
    reporters: ['default', './test/e2e/criteria-reporter.ts'],
  },
});
