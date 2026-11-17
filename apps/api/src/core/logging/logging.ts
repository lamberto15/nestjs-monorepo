import {
  ConsoleLogger,
  type ConsoleLoggerOptions,
  type LogLevel,
} from '@nestjs/common';
import { loggingConfig } from './logging.config.js';
import { type LogRedaction, logRedaction } from './redaction.js';
import { secretVariables } from '../config/secret-files.js';

const LEVELS: LogLevel[] = [
  'verbose',
  'debug',
  'log',
  'warn',
  'error',
  'fatal',
];

/**
 * What another module adds to the log without this one knowing it, set when
 * that module's file loads: `correlation` gives fields for every line (the
 * active trace id, from core/observability), `problem` hears every error
 * and warning's message.
 */
export const logHooks: {
  correlation?: () => Record<string, string>;
  problem?: (message: unknown) => void;
} = {};

/**
 * Nest's ConsoleLogger with the secrets kept out. Its own `redact` option
 * masks the declared keys in structured params and logged objects; what it
 * leaves as is (string messages, an error's message, the stack trace) goes
 * through the text patterns here, on the whole line about to be written. The
 * hooks are ConsoleLogger's own for subclasses: `formatMessage` is the text
 * line, `stringifyJsonLogObject` the JSON one, `printStackTrace` the stack
 * text mode writes after an error.
 */
export class RedactingConsoleLogger extends ConsoleLogger {
  constructor(
    options: ConsoleLoggerOptions,
    private readonly redaction: LogRedaction,
  ) {
    super({ ...options, redact: redaction.paths() });
  }

  /** Fields added to every line (logHooks.correlation). */
  protected correlation(): Record<string, string> {
    return logHooks.correlation?.() ?? {};
  }

  override error(message: unknown, ...rest: unknown[]) {
    logHooks.problem?.(message);
    super.error(message, ...rest);
  }

  override warn(message: unknown, ...rest: unknown[]) {
    logHooks.problem?.(message);
    super.warn(message, ...rest);
  }

  protected override formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
    params?: Record<string, unknown>,
  ): string {
    const extra = Object.entries(this.correlation())
      .map(([key, value]) => `[${key} ${value}] `)
      .join('');
    return this.redaction.redactText(
      super.formatMessage(
        logLevel,
        message,
        pidMessage,
        formattedLogLevel,
        contextMessage + extra,
        timestampDiff,
        params,
      ),
    );
  }

  protected override stringifyJsonLogObject(
    logObject: Record<string, unknown>,
  ): string {
    return this.redaction.redactText(
      super.stringifyJsonLogObject({ ...logObject, ...this.correlation() }),
    );
  }

  protected override printStackTrace(stack: string) {
    super.printStackTrace(stack && this.redaction.redactText(stack));
  }
}

/**
 * The application's logger: JSON, one object per line, in production; readable
 * text in development (LOG_FORMAT, LOG_LEVEL: logging.config.ts). Structured
 * params (`logger.log('Paid', { orderId })`) stay fields of the entry. Logs
 * go to stdout. Building it closes the secret list (redaction.ts).
 */
export function createLogger(
  config: { level: LogLevel; json: boolean } = loggingConfig(),
  redaction: LogRedaction = logRedaction,
  overrides: Partial<ConsoleLoggerOptions> = {},
) {
  const logger = new RedactingConsoleLogger(
    {
      json: config.json,
      // Request fields (requestId, status…) are columns in a log pipeline, not nested.
      flattenParams: true,
      logLevels: LEVELS.slice(LEVELS.indexOf(config.level)),
      ...overrides,
    },
    redaction,
  );
  if (!redaction.frozen) {
    // The variables the modules' configs marked with secret().
    redaction.declare({ fields: [...secretVariables] });
  }
  redaction.freeze('createLogger()');
  return logger;
}
