import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['{src,test}/**/*.e2e-spec.ts'],
    // One template database per run, migrated once (test/global-setup.ts);
    // each file a copy of it as DATABASE_URL (test/setup-env.ts).
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    // Booting a module, copying a database and migrating one take longer
    // than the defaults (10 s and 5 s) when the machine is busy.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // With --coverage (`pnpm test:e2e --coverage`), no thresholds: the unit
    // run's gate is vitest.config.ts.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.e2e-spec.ts', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
