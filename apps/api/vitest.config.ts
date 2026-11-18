import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['{src,test}/**/*.spec.ts'],
    // Runs only with --coverage (`pnpm test:cov`, CI). The thresholds gate
    // the unit tests alone and sit a little under the measured levels
    // (2026-11-18: statements 25.6%, branches 27.9%, functions 21.5%, lines
    // 25.7%; the e2e suite covers the rest): raise them when a change lifts
    // the numbers, never lower.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.e2e-spec.ts', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { statements: 24, branches: 26, functions: 20, lines: 24 },
    },
  },
});
