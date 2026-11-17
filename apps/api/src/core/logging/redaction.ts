/**
 * What never reaches a log line: the keys and text patterns that are masked.
 *
 * - **Keys** (headers and fields) go to Nest's `ConsoleLogger` `redact`
 *   option, which masks a property of that name at any depth of a structured
 *   param or logged object (an error's `cause` included).
 * - **Patterns** cover what the option leaves alone: a secret interpolated
 *   into a string message, an error message or a stack trace. They run over
 *   every line the logger writes (`redactText()`).
 *
 * This file holds the generic ones. A module declares its own from its own
 * folder with `declareSecrets()`, at module scope (the module's
 * `*.config.ts` is the natural place, next to the variable it protects).
 * `createLogger()` closes the list, so a declaration that comes after it
 * throws instead of silently protecting nothing.
 */

/** What a masked value becomes (the word Nest's own default uses). */
export const REDACTED = '[REDACTED]';

/**
 * The request and response headers that carry a credential. Lower case: Nest
 * compares case-insensitively. `Idempotency-Key` is not here: it is a
 * client-chosen id, no use to anyone else.
 */
export const SECRET_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-captcha-token',
  'x-csrf-token',
  'x-xsrf-token',
  'webhook-signature',
  'x-signature',
  'x-hub-signature',
  'x-hub-signature-256',
] as const;

/**
 * The body, query and object fields that hold a secret, wherever they appear.
 * A dotted path masks the key only under that parent: `code` is a two-factor
 * code in a request body (`body.code`) and the OIDC authorization code in a
 * query string (`query.code`, with the `query.state` that binds it), but also
 * every error's `code`, which the logs need.
 */
export const SECRET_FIELDS = [
  'password',
  'currentPassword',
  'newPassword',
  'passwordConfirmation',
  'passphrase',
  'secret',
  'clientSecret',
  'pendingSecret',
  'secretKey',
  'privateKey',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'apiKey',
  'recoveryCode',
  'recoveryCodes',
  'totp',
  'otp',
  'signature',
  'cookie',
  'cookies',
  'sessionId',
  'sid',
  'jwt',
  'authorization',
  'credentials',
  'subscribeUrl',
  'unsubscribeUrl',
  'body.code',
  'query.code',
  'query.state',
] as const;

/** What a module adds from its own folder. */
export interface SecretDeclaration {
  /** Header names whose value is a credential. */
  headers?: string[];
  /** Object, body, query or environment-variable names (or dotted paths) whose value is a secret. */
  fields?: string[];
  /** What a secret looks like in free text; the whole match is replaced (a lookbehind keeps a prefix). */
  patterns?: RegExp[];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface TextRule {
  pattern: RegExp;
  replace: (...match: string[]) => string;
}

const whole = (pattern: RegExp): TextRule => ({
  pattern,
  replace: () => REDACTED,
});

/**
 * The text rules, in the order they run. High precision over reach: a rule
 * that mangles ordinary lines gets switched off, and then protects nothing.
 * Objects go through the key redaction instead; these catch what was
 * interpolated into a string.
 */
function builtInRules(keys: string[]): TextRule[] {
  // Longest first, so `accessToken` wins over `token` where both would match.
  const names = [...keys]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|');
  // The value: one already masked (left as is), a scheme and its credential
  // (the scheme stays), a quoted string, or everything up to a separator.
  const bare = `[^\\s,;&}\\]"']+`;
  const value = `(\\[REDACTED\\]|(?:Bearer|Basic)\\s+(?:\\[REDACTED\\]|${bare})|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|${bare})`;
  // Between the separator and the value, the colour codes of an inspected
  // object in text mode (kept, as part of the separator).
  const separator = `(["']?\\s*[:=]\\s*(?:\\x1b\\[[0-9;]*m)*)`;
  const byName: TextRule[] = names
    ? [
        {
          pattern: new RegExp(
            `\\b([\\w-]*?(?:${names}))${separator}${value}`,
            'gi',
          ),
          replace: (_match, key: string, separator: string, found: string) => {
            if (found === REDACTED) {
              return `${key}${separator}${found}`;
            }
            const scheme = /^(Bearer|Basic)\s/i.exec(found)?.[1];
            if (scheme) {
              return `${key}${separator}${scheme} ${REDACTED}`;
            }
            const quote = found[0] === '"' || found[0] === "'" ? found[0] : '';
            return `${key}${separator}${quote}${REDACTED}${quote}`;
          },
        },
      ]
    : [];
  return [
    // PEM private keys first: they span lines, and the narrower rules
    // below would otherwise eat them piecemeal.
    whole(
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    ),
    // The Authorization schemes and their credential, before the name=value
    // rule, whose value would stop at the space after the scheme.
    {
      pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
      replace: (_match, scheme: string) => `${scheme} ${REDACTED}`,
    },
    // A JWT on its own (an access token in a message).
    whole(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g),
    // The password of a URL (a database or Redis URL in a connection error).
    {
      pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@/]+@/gi,
      replace: (_match, prefix: string) => `${prefix}${REDACTED}@`,
    },
    // A declared name (also at the end of a longer one, as a reset token's),
    // then `=` or `:`, then the value: a header line, a cookie pair, an
    // environment variable, a field of an inspected object or of a JSON
    // line. The name stays, so the line says what was removed; a quoted
    // value keeps its quotes, so a JSON line stays JSON.
    ...byName,
  ];
}

/**
 * The declared keys and patterns, and the text redaction built from them.
 * One instance for the app (`logRedaction`); tests make their own.
 */
export class LogRedaction {
  private readonly names = new Set<string>();
  private readonly extraPatterns: RegExp[] = [];
  private frozenBy?: string;
  private rules?: TextRule[];

  constructor() {
    this.declare({ headers: [...SECRET_HEADERS], fields: [...SECRET_FIELDS] });
  }

  declare({ headers = [], fields = [], patterns = [] }: SecretDeclaration) {
    if (this.frozenBy) {
      throw new Error(
        `Secrets are declared at import time (module scope), before the logger is built: ${[...headers, ...fields, ...patterns.map(String)].join(', ')} was declared after ${this.frozenBy}.`,
      );
    }
    for (const name of [...headers.map((h) => h.toLowerCase()), ...fields]) {
      this.names.add(name);
    }
    for (const pattern of patterns) {
      // Applied globally, whether or not the pattern says `g`.
      this.extraPatterns.push(
        pattern.global
          ? pattern
          : new RegExp(pattern.source, `${pattern.flags}g`),
      );
    }
    this.rules = undefined;
  }

  get frozen() {
    return this.frozenBy !== undefined;
  }

  /** Closes the list: `createLogger()` calls it once the logger holds it. */
  freeze(by: string) {
    this.frozenBy ??= by;
  }

  /** The key names and dotted paths, for Nest's `redact` option. */
  paths(): string[] {
    return [...this.names];
  }

  /**
   * Masks the secrets the patterns find in a text: a log line, an error
   * message. Returns the text itself when nothing matched.
   */
  redactText(text: string): string {
    this.rules ??= [
      ...builtInRules(this.paths().filter((path) => !path.includes('.'))),
      ...this.extraPatterns.map(whole),
    ];
    let result = text;
    for (const rule of this.rules) {
      result = result.replace(rule.pattern, rule.replace);
    }
    return result;
  }
}

/** The app's list: declared at import time, closed by `createLogger()`. */
export const logRedaction = new LogRedaction();

/**
 * How a module protects its own secrets: call it at module scope in the
 * module's own folder, e.g. in `session.config.ts`:
 * `declareSecrets({ fields: ['SESSION_SECRET'], patterns: [/sk_[a-z0-9]{24}/] })`.
 */
export const declareSecrets = (declaration: SecretDeclaration) =>
  logRedaction.declare(declaration);
