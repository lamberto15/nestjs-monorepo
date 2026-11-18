/**
 * Loads `.env` before the app: main.ts and worker.ts pick their `instrument`
 * (`observeInstrument()`, `nestrixInstrument()`) before Nest builds anything,
 * so before ConfigModule has loaded it (what is already set stays).
 */
try {
  process.loadEnvFile();
} catch {
  // No .env file: the environment is the process's own.
}
