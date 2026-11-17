// The environment of an e2e run, set before AppModule loads: the development
// services' database (pnpm services:up), or TEST_DATABASE_URL.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://app:app@127.0.0.1:5432/app';
