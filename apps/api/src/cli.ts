/**
 * The operator CLI: break-glass commands over the app's own services, run
 * on a server by someone who holds its environment (README in src/cli).
 *
 *   pnpm ops <command>                                    (development)
 *   docker compose run --rm api node dist/cli <command>   (a deployment)
 *
 * The app boots as APP_ROLE=api: no queue workers, outbox relay, workflow
 * worker or cron jobs in this short process, and no HTTP listener. What a
 * command starts (a security alert's mail) waits in the queue for the
 * workers. FIRST_START_SEED=off: it never makes the first tenant or
 * administrator (core/tenancy).
 */
process.env.APP_ROLE = 'api';
// No first start here: a fresh database keeps no tenant and no
// administrator until the app starts, so `tenant:import` can fill it.
process.env.FIRST_START_SEED = 'off';
// Before the app: it loads .env.
await import('./core/observability/instrument.js');
await import('./cli/run.js');
