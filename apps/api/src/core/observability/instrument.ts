import { readEnv } from '../config/env.js';
import { schema } from './observability.config.js';
import { startOpenTelemetry } from './telemetry.js';

/**
 * Starts the OpenTelemetry SDK. main.ts and worker.ts import
 * this before the app: it patches the libraries the app loads next, so
 * it cannot start later. That is before ConfigModule has loaded `.env`, so
 * it is loaded here (what is already set stays). A no-op unless
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 */
try {
  process.loadEnvFile();
} catch {
  // No .env file: the environment is the process's own.
}
const env = readEnv(schema);
await startOpenTelemetry(env);
