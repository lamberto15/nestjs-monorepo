import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  encrypted,
  encryptedText,
} from '../../core/encryption/encrypted-columns.js';
import {
  globalTable,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';
import { roles, userRoles } from '../access/access.tables.js';
import { memberships, users } from '../auth/auth.tables.js';
import { organizationalUnits } from '../organization/organization.tables.js';
import type { Oauth2Mapping, Oauth2Preset } from './oauth2-mapping.js';
import { secretColumns } from '../../core/database/secret-columns.js';

/**
 * A tenant's enterprise sign-in (README.md): an OpenID Connect, a SAML 2.0
 * or a plain OAuth 2.0 identity provider of its own. Off until an
 * administrator turns it on.
 */
export const ssoConnections = tenantTable(
  'sso_connections',
  {
    id: uuidPk(),
    name: text('name').notNull(),
    protocol: text('protocol', { enum: ['oidc', 'saml', 'oauth2'] }).notNull(),
    /** Signs people in only when on (an OIDC connection also needs its discovery document). */
    enabled: boolean('enabled').notNull().default(false),
    /**
     * A person of one of the tenant's verified domains who is not a member
     * yet becomes one at their first sign-in (just in time), with an account
     * when the address has none. Off: members come from invitations or SCIM.
     */
    jitProvisioning: boolean('jit_provisioning').notNull().default(false),
    // OpenID Connect
    /** The issuer; its discovery document is `<issuer>/.well-known/openid-configuration`. */
    issuer: text('issuer'),
    clientId: text('client_id'),
    /** Encrypted (core/encryption); never returned. */
    clientSecret: encryptedText('client_secret'),
    /** The issuer's discovery document, fetched on the queue, never during a sign-in. */
    oidcMetadata: jsonb('oidc_metadata').$type<Record<string, unknown>>(),
    metadataFetchedAt: at('metadata_fetched_at'),
    /** Why the last fetch failed (null once one succeeds). */
    metadataError: text('metadata_error'),
    // OAuth 2.0 (no discovery, no ID token); clientId and clientSecret above.
    authorizationEndpoint: text('authorization_endpoint'),
    tokenEndpoint: text('token_endpoint'),
    /** Where the person is read from (one GET with the access token). */
    userinfoEndpoint: text('userinfo_endpoint'),
    /** How the client authenticates at the token endpoint (PKCE is always on). */
    tokenEndpointAuthMethod: text('token_endpoint_auth_method', {
      enum: ['client_secret_post', 'client_secret_basic', 'none'],
    }),
    scopes: jsonb('scopes').$type<string[]>(),
    /** Where the user-info answer holds the person (oauth2-mapping.ts). */
    mapping: jsonb('mapping').$type<Oauth2Mapping>(),
    /** The preset whose defaults filled the fields, if any. */
    preset: jsonb('preset').$type<Oauth2Preset>(),
    // SAML 2.0
    /** The IdP's entity id: the assertions' `Issuer`. */
    idpEntityId: text('idp_entity_id'),
    /** Where the AuthnRequest goes (HTTP-Redirect binding). */
    idpSsoUrl: text('idp_sso_url'),
    /** The IdP's signing certificates (PEM): one, or two during a rotation. */
    idpCertificates: jsonb('idp_certificates')
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Accept responses no request of ours asked for (a login-CSRF vector): opt-in. */
    allowIdpInitiated: boolean('allow_idp_initiated').notNull().default(false),
    /** Refuse a response whose assertion isn't encrypted to `spCertificate`. */
    requireEncryptedAssertions: boolean('require_encrypted_assertions')
      .notNull()
      .default(false),
    /** Our key for this connection (PEM, PKCS#8): signs AuthnRequests, decrypts assertions. Encrypted, never returned. */
    spPrivateKey: encryptedText('sp_private_key'),
    /** Its self-signed certificate (PEM), published in our SP metadata. */
    spCertificate: text('sp_certificate'),
    /**
     * Where the IdP lists the person's groups: a SAML attribute or an ID
     * token claim (`groups` when null). OAuth 2.0 uses `mapping.groups`.
     */
    groupsAttribute: text('groups_attribute'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('sso_connections_tenant_name_idx').on(t.tenantId, t.name),
  ],
  { referenced: true },
);

encrypted(ssoConnections.clientSecret);
encrypted(ssoConnections.spPrivateKey);

/**
 * Who a connection signed in: the IdP's subject, linked to the account at
 * the first sign-in. Keyed by connection, so two tenants' IdPs never share
 * a subject; goes with the connection.
 */
export const ssoIdentities = tenantTable(
  'sso_identities',
  {
    connectionId: uuid('connection_id').notNull(),
    subject: text('subject').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.connectionId, t.subject] }),
    index('sso_identities_user_id_idx').on(t.userId),
    tenantReference(
      'sso_identities_connection_fk',
      [t.tenantId, t.connectionId],
      [ssoConnections.tenantId, ssoConnections.id],
    ),
  ],
);

/**
 * The roles a connection gives: with a `group`, to whoever the IdP lists in
 * it at each sign-in (taken back when it no longer does); without one, to a
 * member it provisions just in time, once.
 */
export const ssoRoleMappings = tenantTable(
  'sso_role_mappings',
  {
    id: uuidPk(),
    connectionId: uuid('connection_id').notNull(),
    /** The IdP's group, compared exactly; null: a just-in-time member's default role. */
    group: text('group'),
    roleId: uuid('role_id').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('sso_role_mappings_connection_group_role_key')
      .on(t.connectionId, t.group, t.roleId)
      .nullsNotDistinct(),
    index('sso_role_mappings_role_id_idx').on(t.roleId),
    tenantReference(
      'sso_role_mappings_connection_fk',
      [t.tenantId, t.connectionId],
      [ssoConnections.tenantId, ssoConnections.id],
    ),
    tenantReference(
      'sso_role_mappings_role_fk',
      [t.tenantId, t.roleId],
      [roles.tenantId, roles.id],
    ),
  ],
);

/**
 * The role grants (`user_roles`) a connection's group mapping made: only
 * these are taken back when the IdP stops listing the group. An
 * administrator's grant stays theirs (rewriting `user_roles` drops the row).
 */
export const ssoRoleGrants = tenantTable(
  'sso_role_grants',
  {
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    index('sso_role_grants_connection_idx').on(t.connectionId, t.userId),
    foreignKey({
      name: 'sso_role_grants_user_role_fk',
      columns: [t.userId, t.roleId],
      foreignColumns: [userRoles.userId, userRoles.roleId],
    }).onDelete('cascade'),
    tenantReference(
      'sso_role_grants_connection_fk',
      [t.tenantId, t.connectionId],
      [ssoConnections.tenantId, ssoConnections.id],
    ),
  ],
);

/** A tenant's SSO policy: one row, absent until an administrator sets it. */
export const ssoPolicies = tenantTable(
  'sso_policies',
  {
    /**
     * Its members act in it only through one of its connections: anything
     * else is refused there (403 `sso_required`), save the exempted.
     */
    requireSso: boolean('require_sso').notNull().default(false),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.tenantId] })],
);

/**
 * The break-glass members of a tenant that requires SSO: they may still
 * sign in otherwise (when the IdP is down). Each use is audited.
 */
export const ssoExemptions = tenantTable(
  'sso_exemptions',
  {
    userId: uuid('user_id').notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    foreignKey({
      name: 'sso_exemptions_membership_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
  ],
);

/**
 * The email domains a tenant proved it controls (a DNS TXT record): an SSO
 * connection may assert, and SCIM provision, only their addresses.
 */
export const ssoDomains = tenantTable(
  'sso_domains',
  {
    id: uuidPk(),
    /** Lower case, no trailing dot. */
    domain: text('domain').notNull(),
    /** What the TXT record must hold; published in DNS, so not a secret. */
    verificationToken: text('verification_token').notNull(),
    verifiedAt: at('verified_at'),
    lastCheckedAt: at('last_checked_at'),
    /** Why the last check failed (null once one succeeds). */
    lastError: text('last_error'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('sso_domains_tenant_domain_idx').on(t.tenantId, t.domain),
  ],
);

/**
 * Which tenants verified an email domain: the sign-in page's lookup by
 * address (POST /auth/sso/discover), before there is a tenant. Kept with
 * `sso_domains` in the same transactions.
 */
export const ssoDomainRoutes = globalTable(
  'sso_domain_routes',
  {
    domain: text('domain').notNull(),
    /** When the tenant verified it: of two tenants, the first answers. */
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.domain, t.tenantId] }),
    index('sso_domain_routes_tenant_id_idx').on(t.tenantId),
  ],
);

/**
 * Sign-ins through a connection under way, bound to the browser that
 * started them: the cookie holds a secret whose SHA-256 is `bindingHash`
 * (the code flows' `state` too). One use each, short-lived.
 */
export const ssoRequests = tenantTable(
  'sso_requests',
  {
    id: uuidPk(),
    connectionId: uuid('connection_id').notNull(),
    bindingHash: text('binding_hash').notNull(),
    /** PKCE's verifier, and OIDC's nonce. */
    codeVerifier: text('code_verifier'),
    nonce: text('nonce'),
    /** SAML: the AuthnRequest's ID, which the response's `InResponseTo` names. */
    samlRequestId: text('saml_request_id'),
    /** A path of the web app to land on. */
    redirectTo: text('redirect_to'),
    /** SAML: the account the response signed in, between the ACS and the sign-in. */
    userId: uuid('user_id'),
    /** When the IdP authenticated the person (`AuthnInstant`). */
    authenticatedAt: at('authenticated_at'),
    createdAt: at('created_at').notNull().defaultNow(),
    expiresAt: at('expires_at').notNull(),
    consumedAt: at('consumed_at'),
  },
  (t) => [
    uniqueIndex('sso_requests_tenant_binding_idx').on(
      t.tenantId,
      t.bindingHash,
    ),
    index('sso_requests_connection_saml_idx').on(
      t.connectionId,
      t.samlRequestId,
    ),
    index('sso_requests_expires_at_idx').on(t.expiresAt),
    tenantReference(
      'sso_requests_connection_fk',
      [t.tenantId, t.connectionId],
      [ssoConnections.tenantId, ssoConnections.id],
    ),
  ],
);

/** SAML assertions already used, by their ID, until they expire: a replay is refused. */
export const ssoAssertions = tenantTable(
  'sso_assertions',
  {
    connectionId: uuid('connection_id').notNull(),
    assertionId: text('assertion_id').notNull(),
    expiresAt: at('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.connectionId, t.assertionId] }),
    index('sso_assertions_expires_at_idx').on(t.expiresAt),
    tenantReference(
      'sso_assertions_connection_fk',
      [t.tenantId, t.connectionId],
      [ssoConnections.tenantId, ssoConnections.id],
    ),
  ],
);

/**
 * What a tenant's SCIM client said about a member it provisioned: the
 * account stays global and its own, so the name and address it sends are
 * kept here, never written to the account. Goes with the membership.
 */
export const scimUsers = tenantTable(
  'scim_users',
  {
    userId: uuid('user_id').notNull(),
    externalId: text('external_id'),
    /** The SCIM attributes last written (no `id`, `meta`, `schemas`, `active`). */
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    uniqueIndex('scim_users_tenant_external_id_idx').on(
      t.tenantId,
      t.externalId,
    ),
    foreignKey({
      name: 'scim_users_membership_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
  ],
);

/** The organizational units a tenant's SCIM client manages as groups. */
export const scimGroups = tenantTable(
  'scim_groups',
  {
    unitId: uuid('unit_id').notNull(),
    externalId: text('external_id'),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.unitId] }),
    uniqueIndex('scim_groups_tenant_external_id_idx').on(
      t.tenantId,
      t.externalId,
    ),
    tenantReference(
      'scim_groups_unit_fk',
      [t.tenantId, t.unitId],
      [organizationalUnits.tenantId, organizationalUnits.id],
      'restrict',
    ),
  ],
);

/**
 * Accounts SCIM deactivated because their last active membership was
 * deprovisioned (`users.active` false): a later SCIM provisioning, which
 * finds the row, turns the same account back on. Global, as `users`.
 */
export const scimDeprovisionedUsers = pgTable('scim_deprovisioned_users', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  deprovisionedAt: at('deprovisioned_at').notNull().defaultNow(),
});

secretColumns(ssoConnections, [
  ssoConnections.clientSecret,
  ssoConnections.spPrivateKey,
]);

secretColumns(ssoRequests, [ssoRequests.bindingHash, ssoRequests.codeVerifier]);
