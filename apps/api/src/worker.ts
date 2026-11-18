import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

/**
 * The worker process: the same app with APP_ROLE=worker, run as a plain
 * application context (no HTTP server). It runs the queue workers and the
 * scheduled jobs; API instances (APP_ROLE=api) run none of it, so a heavy
 * job never slows a request down, and each side scales on its own.
 *
 *   node dist/worker
 */
process.env.APP_ROLE = 'worker';
// Before the app: it loads .env, which the instrument below reads.
await import('./core/observability/instrument.js');
// After the role is set: AppModule is not loaded before this line.
const { AppModule } = await import('./app.module.js');
const { createLogger } = await import('./core/logging/logging.js');
const { observeInstrument } = await import('./core/observability/observe.js');
const { nestrixInstrument } = await import('./core/observability/nestrix.js');

const app = await NestFactory.createApplicationContext(AppModule, {
  bufferLogs: true,
  instrument: observeInstrument() ?? nestrixInstrument(),
});
app.useLogger(createLogger());
// On SIGTERM the workers finish the jobs they run, then the modules close what they hold.
app.enableShutdownHooks();
Logger.log('Worker running', 'Bootstrap');
