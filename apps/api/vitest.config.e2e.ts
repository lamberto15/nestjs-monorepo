import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // One template database per run, migrated once (test/global-setup.ts);
    // each file a copy of it as DATABASE_URL (test/setup-env.ts).
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    // Booting a module and copying a database take longer than the 10 s
    // default when the machine is busy.
    hookTimeout: 60_000,
  },
});
