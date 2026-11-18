# iam/sso

Enterprise sign-on for a tenant: its OpenID Connect, OAuth 2.0 and SAML
connections, the email domains it verified, "SSO required" with
break-glass exemptions, and SCIM 2.0 provisioning of its users and groups.

## Routes

| Route                                                                                                                                         | Who                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `/v1/sso/connections` (CRUD, `…/:id/refresh`), `POST /v1/sso/saml/metadata`                                                                   | `Access.manageSso` (administrators)           |
| `/v1/sso/domains` (add, `…/:id/verify`, delete)                                                                                               | `Access.manageSso`                            |
| `GET`/`PUT /v1/sso/policy`, `PUT`/`DELETE /v1/sso/exemptions/:userId`                                                                         | `Access.manageSso`                            |
| `POST /v1/auth/sso/discover`                                                                                                                  | public: an address's login URL, or null       |
| `/v1/auth/sso/:tenantId/:connectionId/login`, `…/oidc/callback`, `…/oauth2/callback`, `POST …/saml/acs`, `…/saml/complete`, `…/saml/metadata` | public: the browser's sign-in                 |
| `/v1/scim/*` (ServiceProviderConfig, ResourceTypes, Users, Groups)                                                                            | an API client key with `Access.provisionScim` |

A connection starts off; a sign-in lands on the web app (`WEB_URL`, else
`APP_URL`: core/http's), with `?error=sso_failed` when refused, the reason in the
tenant's audit log (`auth.sign-in-failed`). A first sign-in provisions the
person just in time (`jitProvisioning`) or links the account of a
verified address; roles come from the connection's default roles and its
group mappings, granted only within what the mapping's author could grant.

Jobs (queue `sso`, system job `sso`): an OIDC connection's discovery
document, and a domain's TXT record (`_sso-verification.<domain>`).

## Configuration

| Variable               | Default |                                                                      |
| ---------------------- | ------- | -------------------------------------------------------------------- |
| `SSO_ALLOW_LOOPBACK`   | `off`   | Development and tests only: allows `http://` and loopback providers. |
| `DATA_ENCRYPTION_KEYS` | none    | Required: client secrets and SP keys are encrypted columns.          |

## SSO required

`PUT /v1/sso/policy { requireSso: true }` needs an enabled connection, and
refuses (`sso_lockout`) unless the administrator asking is signed in
through one of the tenant's connections or exempted. An exemption
(break-glass) needs a confirmed second factor (`sso_exemption_needs_mfa`;
without two-factor in the app, nobody can be exempted: fail closed). Then
every session or token of the tenant not signed in through its own
connection gets 403 `sso_required` on every route save those marked
`@WithoutSso()` (iam/auth: sign-out, the tenants list and switch, an
invitation's acceptance, signing out everywhere); public routes are
untouched. A password or passkey sign-in asks first (see "How it plugs in").

## SCIM

Base URL `{APP_URL}/v1/scim`; the token is an API client's key whose role
holds `Access.provisionScim`, and its tenant is the one provisioned. Users
are addresses of the tenant's verified domains: a new account without a
password, or the account of that address. `active: false` (PATCH, PUT) or
DELETE deactivates the membership; with no other active membership left
the account itself is deactivated (`scim_deprovisioned_users` remembers
it was SCIM), and provisioning it again reactivates it. Never deleted.
Groups are top-level units (type `team`) whose members are provisioned
users; a removed member's unit membership is ended, kept as history.
Filters: `eq` joined by `and` (scim2-parse-filter), PATCH by scim-patch.

## What is checked

- **SAML** (@node-saml/node-saml, never a hand-written signature check):
  the Response **and** its assertion must be signed, against the
  connection's certificates (`wantAuthnResponseSigned`,
  `wantAssertionsSigned`), so an encrypted assertion is authenticated
  before it is decrypted. Then every signature, digest and encryption
  algorithm must be on an allowlist (`saml-algorithms.ts`, read
  with a namespace-aware parser): RSA or ECDSA with SHA-256/384/512,
  SHA-2 digests, AES-CBC or AES-GCM with RSA-OAEP; SHA-1 (which xml-crypto
  still accepts), RSA PKCS#1 v1.5 and 3DES are refused, and anything
  unknown fails closed. Each connection has its own key pair
  (`saml.spCertificate`, RSA-3072, five years, the key in an encrypted
  column): it signs our AuthnRequests (HTTP-Redirect `SigAlg`/`Signature`)
  and decrypts assertions the IdP encrypts to it, both in our metadata;
  `requireEncryptedAssertions` refuses a plain one. Also checked:
  audience (our entity id), `NotBefore`/`NotOnOrAfter` with two minutes of
  clock skew, the assertion's age (ten minutes), and the `Issuer`. SP-
  initiated by default: `InResponseTo` must name a request **this browser**
  started (a cookie bound to it, `__Host-sso_tx`), so another browser's
  assertion is refused (login CSRF). `allowIdpInitiated` accepts
  unsolicited responses, a login-CSRF vector: off by default. Each
  assertion's ID is kept until it expires: a replay is refused. A transient
  NameID is refused (an identity needs a stable subject).
- **OpenID Connect** (openid-client): the authorization code flow with
  PKCE, `state` (the browser's binding) and `nonce`; the ID token's
  signature, `iss`, `aud`, `exp`; `email_verified` must be `true`.
- **OAuth 2.0** (openid-client, no discovery): the authorization code flow
  with PKCE and `state` (the browser's binding), the configured client
  authentication; one user-info GET, mapped by the connection
  (`oauth2-mapping.ts`): a stable subject, and
  the address vouched for as its `emailVerified` says. No ID token, so
  nothing the provider signed: what is weaker is listed there.
- **No account takeover.** An identity is keyed by the IdP's subject under
  `sso:<connection id>` (never shared between tenants). A first sign-in
  links an existing account only when its address is in a domain the tenant
  verified and the account proved its address (else whoever registered it
  first, with a password of their choosing, would get the person's
  sign-ins); a deactivated account or membership is refused.
- **SSRF.** The issuer, its discovery document, keys and token endpoint,
  and an OAuth 2.0 connection's token and user-info endpoints, are
  fetched through `core/http/safe-fetch.ts`: https only, every resolved
  address checked in the socket's own lookup (link-local, metadata,
  private and reserved ranges refused), no redirects, 10 s and 512 KiB.
  `SSO_ALLOW_LOOPBACK=on` (development and tests only) allows `http://` on
  loopback and private networks.
- **Secrets.** The OIDC or OAuth 2.0 client secret is an encrypted column
  (core/encryption: `DATA_ENCRYPTION_KEYS` is required at boot once this module is loaded), never
  answered. Requests' PKCE verifiers and bindings live ten minutes;
  bindings are stored as their SHA-256.
- **The ACS** is a cross-site form POST by design: it must be exempt from
  the CSRF check (`http-setup.ts`, see Integration), signs nobody in, and hands over to `GET
…/saml/complete` (same site, the same browser's binding, two minutes,
  once), which does.

## How it plugs in

Seams the other iam modules own, which this one implements:

- `SsoPolicyService` is iam/auth's `@SignInGate()`: a password, passkey or
  native sign-in lands in a tenant that lets the method in, or 403
  `sso_required`; an exempted member's use is audited
  (`sso.exemption-used`). Routes marked `@WithoutSso()` (iam/auth) skip
  the global guard.
- `ScimUsersService` is access's `@ScimMembers()` (`managedByScim` on the
  users routes) and listens for `access.member-reactivated`: an
  administrator turning a membership back on reactivates the account SCIM
  deprovisioned (audited `user.account-reactivated`).
- `ScimGroupsService` is organization's `@ScimUnits()`: its units show
  `managedByScim` and refuse an administrator's change (409
  `unit_managed_by_scim`).
- SCIM's deactivations emit `access.member-deactivated` with the IdP's API
  client as the actor: realtime ends the member's sockets in the tenant.
- `Access.manageSso` opens the roles and users lists (access's
  `openForSso`) for the SSO page's pickers.
- The ACS is excluded from the CSRF check here (`csrfExclusions`, in
  sso.module.ts).
