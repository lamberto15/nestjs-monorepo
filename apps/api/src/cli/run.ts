import { CommandFactory } from 'nest-commander';
import { createLogger } from '../core/logging/logging.js';
import { NotConfirmed } from './confirm.js';
import { CliModule } from './cli.module.js';
import { CliError } from './plan.js';

/** A refusal is a message and an exit code, not a stack. */
const fail = (error: unknown) => {
  if (error instanceof CliError || error instanceof NotConfirmed) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  throw error;
};

await CommandFactory.run(CliModule, {
  // The app's logger (its redaction included), warnings and errors only.
  logger: createLogger({ level: 'warn', json: false }),
  cliName: 'ops',
  usePlugins: false,
  serviceErrorHandler: fail,
});
