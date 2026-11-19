# iam/api-clients

Exports `ApiClientsService` and `ActiveRequester`: `of(principal)` checks, in a queued job's tenant, that the user who queued it is still an active member (or the API client still active); null when not (modules/ai and modules/documents use it).

Systems that call the API with a key: the tenant's API clients and their
keys, managed by administrators under `/v1/access/clients` (user sessions
only). What lets a key in (the key format, hashing, the address allowlist,
last-used tracking) is iam/auth's; the tables are auth's (`api_clients`,
`api_keys`) and access's (`api_client_roles`).

- **Keys** are shown once, in the response that makes them; only the public
  id and the SHA-256 are stored. A client may hold several: `POST
/clients/{id}/rotate { graceSeconds }` makes a new one and the current
  ones stop after the grace period (0: now); a key may end at a date
  (`keyExpiresAt`, `expiresAt`) and be revoked alone.
- **Permissions:** `Access.manageClients` changes clients; reading is
  `AccessPolicy.open`. You may act on a client only if you hold, without
  conditions, every permission its roles give (403 `authority_required`).
  Roles follow the grant rule of RolesService and may end at a date.
- **Quota at create:** `dailyQuota` on `POST /clients` is set in the
  create's transaction by the provider marked `@ClientQuota()`
  (modules/usage, `Usage.setClientQuota`: 403 without it); without one, 400.
- **Switch:** `API_CLIENTS` (iam/auth): off, the routes answer 404.
- **Audit:** `client.created`, `.revoked`, `.activated`,
  `.allowlist-changed`, `.roles-changed`, `.key-rotated`,
  `.key-revoked`, `.deleted`.
- **Events** (api-clients.events.ts, after the commit; modules/realtime ends
  the sockets): `access.client-revoked { clientId, tenantId }` (deleted or
  deactivated), `access.keys-revoked { keyIds }` (revoked, or rotated with
  no grace period). A rotation also publishes the domain event
  `security.api-key-rotated { clientId, keyId, previousKeysEnd }` (core/outbox,
  in its transaction); modules/webhooks sends it to the rotated client's
  endpoints that subscribe to it, and to no other client: every client holds
  `ApiKey.read` of its own keys only (`api-clients.permissions.ts`).

Remove: `pnpm module:remove api-clients` ([removing-a-module](../../../../../docs/removing-a-module.md)).

Not here: a daily request quota and webhook endpoint counts (usage and
webhooks modules).
