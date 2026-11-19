# core/secrets

Secrets the app makes for itself and every instance must share (the access
tokens' signing key when `JWT_SECRET` is unset; likewise IDEMPOTENCY_KEYS,
CURSOR_KEYS, STORAGE_SIGNING_KEYS and the web-push keys when unset, and the
unsubscribe, deletion-cancel and passkey-decoy keys). `SecretsModule` is
global: inject `Secrets`. `app_secrets` holds one row per name.

```ts
const key = await secrets.loadOrCreate('jwt-signing-key', () =>
  randomBytes(32).toString('base64url'),
);
```

The first caller's value wins (insert on conflict do nothing, then read).
With `DATA_ENCRYPTION_KEYS` set, values are encrypted with core/encryption;
one stored in plaintext or under an older key is rewritten under the current
key when read. A secret set in the environment always wins over this table.

Tests: `secrets.e2e-spec.ts`.
