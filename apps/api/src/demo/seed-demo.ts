/**
 * `pnpm db:seed:demo`: the demo tenant, its units and its people on a
 * development database (README in this folder). The app boots as
 * APP_ROLE=api: no workers, relay or cron jobs, no HTTP listener.
 */
process.env.APP_ROLE = 'api';
await import('./run-demo-seed.js');
