# core/secrets

Secrets the app makes for itself and every instance must share (the access
tokens' signing key when `JWT_SECRET` is unset). `app_secrets` holds one
row per name.

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
