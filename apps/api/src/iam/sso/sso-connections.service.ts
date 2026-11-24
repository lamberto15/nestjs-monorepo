import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Queue } from 'bullmq';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import { httpConfig } from '../../core/http/http.config.js';
import { EncryptedColumns } from '../../core/encryption/encrypted-columns.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { withTenant } from '../../core/tenancy/tenant-job.js';
import { RolesService } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { Principal, UserPrincipal } from '../auth/principal.js';
import { SsoAccounts } from './sso-accounts.service.js';
import { SsoConnectionsRepository } from './sso-connections.repository.js';
import { ssoConfig } from './sso.config.js';
import type { CreateConnection, UpdateConnection } from './sso.schemas.js';
import { endpointProblem, presetDefaults } from './oauth2-mapping.js';
import { SSO_QUEUE, type SsoJob } from './sso.queue.js';
import { ssoConnections } from './sso.tables.js';
import { describeCertificate, newSpKeyPair } from './sp-keys.js';

export type SsoConnection = typeof ssoConnections.$inferSelect;

/** A connection's role mappings as the API shows them. */
interface RoleSetup {
  roleMappings: { group: string; roleId: string }[];
  defaultRoleIds: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CreateOauth2 = Extract<CreateConnection, { protocol: 'oauth2' }>;

/** The fields of each protocol: a change naming another protocol's is a 400. */
const PROTOCOL_FIELDS = {
  oidc: ['issuer', 'clientId', 'clientSecret'],
  saml: [
    'idpEntityId',
    'idpSsoUrl',
    'idpCertificates',
    'allowIdpInitiated',
    'requireEncryptedAssertions',
  ],
  oauth2: [
    'authorizationEndpoint',
    'tokenEndpoint',
    'userinfoEndpoint',
    'clientId',
    'clientSecret',
    'tokenEndpointAuthMethod',
    'scopes',
    'mapping',
  ],
} as const satisfies Record<
  SsoConnection['protocol'],
  readonly (keyof UpdateConnection)[]
>;
const ALL_PROTOCOL_FIELDS = [
  ...new Set(Object.values(PROTOCOL_FIELDS).flat()),
] as (keyof UpdateConnection)[];

/**
 * A tenant's SSO connections (README.md): created off,
 * changed and deleted by its administrators (`Access.manageSso`), each
 * change audited in its transaction. The OIDC client secret is encrypted
 * (core/encryption) and never read back out; the issuer's discovery
 * document is fetched on the queue (SsoProcessor), never in a request.
 */
@EncryptedColumns([ssoConnections.clientSecret, ssoConnections.spPrivateKey])
@Injectable()
export class SsoConnectionsService {
  constructor(
    private readonly repository: SsoConnectionsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly audit: AuditService,
    private readonly encryption: EncryptionService,
    private readonly tenancy: Tenancy,
    private readonly roles: RolesService,
    @Inject(ssoConfig.KEY)
    private readonly config: ConfigType<typeof ssoConfig>,
    @Inject(httpConfig.KEY)
    private readonly http: ConfigType<typeof httpConfig>,
    @InjectQueue(SSO_QUEUE) private readonly queue: Queue<SsoJob>,
    private readonly accounts: SsoAccounts,
  ) {}

  async list() {
    const rows = await this.repository.list();
    const roles = await this.roleSetups(rows.map((row) => row.id));
    return rows.map((row) => this.view(row, roles.get(row.id)));
  }

  async get(id: string) {
    const row = await this.find(id);
    return this.view(row, (await this.roleSetups([id])).get(id));
  }

  async create(actor: UserPrincipal, input: CreateConnection, ip?: string) {
    await this.checkRoles(actor, input);
    if (input.protocol === 'oauth2' && input.groupsAttribute) {
      throw fieldsRefused('oauth2', ['groupsAttribute']);
    }
    const values =
      input.protocol === 'oauth2'
        ? this.oauth2Values(input)
        : input.protocol === 'oidc'
          ? {
              issuer: this.checkUrl(input.issuer, 'issuer'),
              clientId: input.clientId,
              clientSecret: this.encryption.encrypt(
                ssoConnections.clientSecret,
                input.clientSecret,
              ),
            }
          : {
              idpEntityId: input.idpEntityId,
              idpSsoUrl: this.checkUrl(input.idpSsoUrl, 'idpSsoUrl'),
              idpCertificates: input.idpCertificates,
              allowIdpInitiated: input.allowIdpInitiated ?? false,
              requireEncryptedAssertions:
                input.requireEncryptedAssertions ?? false,
              ...(await this.newSpKeys()),
            };
    const row = await this.txHost.withTransaction(async () => {
      const created = await this.repository
        .insert({
          name: input.name,
          protocol: input.protocol,
          enabled: input.enabled ?? false,
          jitProvisioning: input.jitProvisioning ?? false,
          groupsAttribute: input.groupsAttribute ?? null,
          ...values,
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error) ? nameTaken(input.name) : error;
        });
      await this.writeRoleSetup(created.id, input);
      await this.audit.record(actor, {
        action: 'sso.connection-created',
        targetType: 'sso-connection',
        targetId: created.id,
        details: {
          name: created.name,
          protocol: created.protocol,
          ...(created.preset && { preset: created.preset.name }),
          enabled: created.enabled,
          jitProvisioning: created.jitProvisioning,
          ...roleDetails(input),
        },
        ip,
      });
      return created;
    });
    if (row.protocol === 'oidc') {
      await this.queueDiscovery(row.id);
    }
    return this.get(row.id);
  }

  async update(
    actor: UserPrincipal,
    id: string,
    changes: UpdateConnection,
    ip?: string,
  ) {
    const before = await this.find(id);
    const own: readonly string[] = PROTOCOL_FIELDS[before.protocol];
    const wrong: string[] = ALL_PROTOCOL_FIELDS.filter(
      (field) => !own.includes(field) && changes[field] !== undefined,
    );
    // An OAuth 2.0 connection's groups are `mapping.groups`.
    if (before.protocol === 'oauth2' && changes.groupsAttribute) {
      wrong.push('groupsAttribute');
    }
    if (wrong.length > 0) {
      throw fieldsRefused(before.protocol, wrong);
    }
    if (before.protocol === 'oauth2') {
      const method =
        changes.tokenEndpointAuthMethod ?? before.tokenEndpointAuthMethod;
      if (
        method !== 'none' &&
        changes.clientSecret === undefined &&
        !before.clientSecret
      ) {
        throw missingFields(['clientSecret']);
      }
    }
    // Who the IdP is (its keys, URLs, client, claims) decides who gets the
    // roles a connection hands out: whoever changes it takes those roles
    // over, and must be able to grant them, as if they had mapped them.
    const trustChanged =
      ALL_PROTOCOL_FIELDS.some((field) => changes[field] !== undefined) ||
      changes.groupsAttribute !== undefined;
    const kept = trustChanged
      ? (await this.roleMappingsOf(id))
          .filter((mapping) =>
            mapping.group === null
              ? changes.defaultRoleIds === undefined
              : changes.roleMappings === undefined,
          )
          .map((mapping) => mapping.roleId)
      : [];
    await this.checkRoles(actor, changes, kept);
    const issuerChanged =
      changes.issuer !== undefined && changes.issuer !== before.issuer;
    const row = await this.txHost.withTransaction(async () => {
      const updated = await this.repository
        .update(id, {
          ...(changes.name !== undefined && { name: changes.name }),
          ...(changes.enabled !== undefined && { enabled: changes.enabled }),
          ...(changes.jitProvisioning !== undefined && {
            jitProvisioning: changes.jitProvisioning,
          }),
          ...(changes.issuer !== undefined && {
            issuer: this.checkUrl(changes.issuer, 'issuer'),
          }),
          // A new issuer: its document is fetched again before a sign-in.
          ...(issuerChanged && {
            oidcMetadata: null,
            metadataFetchedAt: null,
            metadataError: null,
          }),
          ...(changes.clientId !== undefined && { clientId: changes.clientId }),
          ...(changes.clientSecret !== undefined && {
            clientSecret: this.encryption.encrypt(
              ssoConnections.clientSecret,
              changes.clientSecret,
            ),
          }),
          ...(changes.idpEntityId !== undefined && {
            idpEntityId: changes.idpEntityId,
          }),
          ...(changes.idpSsoUrl !== undefined && {
            idpSsoUrl: this.checkUrl(changes.idpSsoUrl, 'idpSsoUrl'),
          }),
          ...(changes.idpCertificates !== undefined && {
            idpCertificates: changes.idpCertificates,
          }),
          ...(changes.allowIdpInitiated !== undefined && {
            allowIdpInitiated: changes.allowIdpInitiated,
          }),
          ...(changes.requireEncryptedAssertions !== undefined && {
            requireEncryptedAssertions: changes.requireEncryptedAssertions,
          }),
          ...(changes.groupsAttribute !== undefined && {
            groupsAttribute: changes.groupsAttribute,
          }),
          ...(changes.authorizationEndpoint !== undefined && {
            authorizationEndpoint: this.checkEndpoint(
              changes.authorizationEndpoint,
              'authorizationEndpoint',
            ),
          }),
          ...(changes.tokenEndpoint !== undefined && {
            tokenEndpoint: this.checkEndpoint(
              changes.tokenEndpoint,
              'tokenEndpoint',
            ),
          }),
          ...(changes.userinfoEndpoint !== undefined && {
            userinfoEndpoint: this.checkEndpoint(
              changes.userinfoEndpoint,
              'userinfoEndpoint',
            ),
          }),
          ...(changes.tokenEndpointAuthMethod !== undefined && {
            tokenEndpointAuthMethod: changes.tokenEndpointAuthMethod,
          }),
          ...(changes.scopes !== undefined && { scopes: changes.scopes }),
          ...(changes.mapping !== undefined && { mapping: changes.mapping }),
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error) ? nameTaken(changes.name!) : error;
        });
      await this.writeRoleSetup(id, changes);
      await this.audit.record(actor, {
        action: 'sso.connection-updated',
        targetType: 'sso-connection',
        targetId: id,
        details: {
          name: updated.name,
          // Which fields changed, never a secret's value.
          changed: Object.keys(changes).filter(
            (key) => changes[key as keyof UpdateConnection] !== undefined,
          ),
          ...(changes.enabled !== undefined && {
            enabled: { from: before.enabled, to: changes.enabled },
          }),
          ...roleDetails(changes),
        },
        ip,
      });
      return updated;
    });
    if (issuerChanged) {
      await this.queueDiscovery(id);
    }
    // Turned off: the sessions it signed in end, once that is committed.
    if (before.enabled && changes.enabled === false) {
      await this.accounts.endSessions(id, await this.accounts.usersOf(id));
    }
    return this.get(row.id);
  }

  async remove(actor: UserPrincipal, id: string, ip?: string) {
    const signedIn = await this.txHost.withTransaction(async () => {
      // Read before the delete takes the identities with it.
      const userIds = await this.accounts.usersOf(id);
      const row = await this.repository.delete(id);
      if (!row) {
        throw notFound(id);
      }
      await this.audit.record(actor, {
        action: 'sso.connection-deleted',
        targetType: 'sso-connection',
        targetId: id,
        details: { name: row.name, protocol: row.protocol },
        ip,
      });
      return userIds;
    });
    await this.accounts.endSessions(id, signedIn);
  }

  /**
   * Fetches an OIDC connection's discovery document again (202: on the
   * queue). An OAuth 2.0 connection has none (409): its endpoints are its
   * own fields.
   */
  async refreshMetadata(id: string) {
    const row = await this.find(id);
    if (row.protocol === 'oauth2') {
      throw new ConflictException({
        code: 'sso_no_discovery',
        message:
          'An OAuth 2.0 connection has no discovery document: its endpoints are its own fields.',
      });
    }
    if (row.protocol !== 'oidc') {
      throw new BadRequestException(
        'Only an OpenID Connect connection has a discovery document.',
      );
    }
    await this.queueDiscovery(id);
  }

  /**
   * The job's work (SsoProcessor, in the connection's tenant): stores the
   * discovery document, or why it couldn't be had, and audits the outcome.
   */
  async storeDiscovery(
    actor: Principal,
    id: string,
    discover: (
      issuer: string,
      clientId: string,
    ) => Promise<Record<string, unknown>>,
  ) {
    const row = await this.repository.findById(id);
    if (!row || row.protocol !== 'oidc' || !row.issuer || !row.clientId) {
      return;
    }
    let metadata: Record<string, unknown> | null = null;
    let error: string | null = null;
    try {
      metadata = await discover(row.issuer, row.clientId);
    } catch (failure) {
      error = (failure as Error).message.slice(0, 500);
    }
    await this.txHost.withTransaction(async () => {
      // Only for the issuer it was fetched for: a change meanwhile queued another.
      await this.repository.storeDiscovery(
        id,
        row.issuer!,
        metadata
          ? {
              oidcMetadata: metadata,
              metadataFetchedAt: new Date(),
              metadataError: null,
            }
          : { metadataError: error },
      );
      await this.audit.record(actor, {
        action: metadata ? 'sso.metadata-fetched' : 'sso.metadata-fetch-failed',
        targetType: 'sso-connection',
        targetId: id,
        details: { issuer: row.issuer, ...(error && { error }) },
      });
    });
  }

  /**
   * The enabled connection `connectionId` of the active tenant `tenantId`,
   * read in that tenant's scope, or null: no such tenant, no such
   * connection in it, or one that is off. The public sign-in routes answer
   * all of these alike.
   */
  async resolveEnabled(tenantId: string, connectionId: string) {
    if (!UUID.test(tenantId) || !UUID.test(connectionId)) {
      return null;
    }
    const tenant = await this.tenancy.find(tenantId.toLowerCase());
    if (!tenant?.active) {
      return null;
    }
    const row = await this.tenancy.run(tenant.id, () =>
      this.repository.findEnabled(connectionId.toLowerCase()),
    );
    return row ?? null;
  }

  /** The OIDC or OAuth 2.0 client secret, for the token request (in the connection's tenant). */
  clientSecret(connection: SsoConnection) {
    return this.encryption.decrypt(
      ssoConnections.clientSecret,
      connection.clientSecret,
      connection.tenantId,
    );
  }

  /**
   * Our key and certificate of a SAML connection: its own, made with it.
   * A connection made before keys existed gets its pair now, once (the
   * update is conditional: two first sign-ins at once keep one pair).
   */
  async samlKeys(
    connection: SsoConnection,
  ): Promise<{ privateKey: string; certificate: string }> {
    if (connection.spPrivateKey && connection.spCertificate) {
      return {
        privateKey: this.encryption.decrypt(
          ssoConnections.spPrivateKey,
          connection.spPrivateKey,
          connection.tenantId,
        )!,
        certificate: connection.spCertificate,
      };
    }
    const keys = await this.newSpKeys();
    const stored = await this.repository.setSpKeysIfNone(connection.id, keys);
    return this.samlKeys(stored ?? (await this.find(connection.id)));
  }

  /**
   * The roles a connection maps the IdP's groups to (`group` set) and those
   * it gives a just-in-time member (`group` null).
   */
  async roleMappingsOf(connectionId: string) {
    return this.repository.roleMappingsOf(connectionId);
  }

  /** The URLs of a connection, under APP_URL. */
  urls(connection: Pick<SsoConnection, 'id' | 'tenantId'>) {
    const base = `${this.http.appUrl}/v1/auth/sso/${connection.tenantId}/${connection.id}`;
    return {
      login: `${base}/login`,
      oidcCallback: `${base}/oidc/callback`,
      oauth2Callback: `${base}/oauth2/callback`,
      samlAcs: `${base}/saml/acs`,
      samlComplete: `${base}/saml/complete`,
      samlMetadata: `${base}/saml/metadata`,
    };
  }

  /**
   * An OAuth 2.0 connection's fields: the preset's defaults (Lark), each
   * overridden by what was sent, then checked complete. Its endpoints are
   * usable as soon as it is on: no discovery.
   */
  private oauth2Values(input: CreateOauth2) {
    const defaults = input.preset ? presetDefaults(input.preset) : undefined;
    const merged = {
      authorizationEndpoint:
        input.authorizationEndpoint ?? defaults?.authorizationEndpoint,
      tokenEndpoint: input.tokenEndpoint ?? defaults?.tokenEndpoint,
      userinfoEndpoint: input.userinfoEndpoint ?? defaults?.userinfoEndpoint,
      tokenEndpointAuthMethod:
        input.tokenEndpointAuthMethod ??
        defaults?.tokenEndpointAuthMethod ??
        ('client_secret_basic' as const),
      scopes: input.scopes ?? defaults?.scopes ?? [],
      mapping: input.mapping ?? defaults?.mapping,
    };
    const missing: string[] = (
      [
        'authorizationEndpoint',
        'tokenEndpoint',
        'userinfoEndpoint',
        'mapping',
      ] as const
    ).filter((field) => !merged[field]);
    if (merged.tokenEndpointAuthMethod !== 'none' && !input.clientSecret) {
      missing.push('clientSecret');
    }
    if (missing.length > 0) {
      throw missingFields(missing);
    }
    return {
      authorizationEndpoint: this.checkEndpoint(
        merged.authorizationEndpoint!,
        'authorizationEndpoint',
      ),
      tokenEndpoint: this.checkEndpoint(merged.tokenEndpoint!, 'tokenEndpoint'),
      userinfoEndpoint: this.checkEndpoint(
        merged.userinfoEndpoint!,
        'userinfoEndpoint',
      ),
      clientId: input.clientId,
      clientSecret: input.clientSecret
        ? this.encryption.encrypt(
            ssoConnections.clientSecret,
            input.clientSecret,
          )
        : null,
      tokenEndpointAuthMethod: merged.tokenEndpointAuthMethod,
      scopes: merged.scopes,
      mapping: merged.mapping!,
      preset: input.preset ?? null,
    };
  }

  /** An OAuth 2.0 endpoint, or a 400 saying what is wrong with it (`endpointProblem()`). */
  private checkEndpoint(value: string, field: string) {
    const problem = endpointProblem(value, this.config.allowLoopback);
    if (problem) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: `${field}: ${problem}`,
        errors: [{ path: field, message: problem }],
      });
    }
    return value;
  }

  /** A new SP key pair, its key encrypted for the column. */
  private async newSpKeys() {
    const host = new URL(this.http.appUrl).hostname;
    const keys = await newSpKeyPair(`${host} SAML SP`);
    return {
      spPrivateKey: this.encryption.encrypt(
        ssoConnections.spPrivateKey,
        keys.privateKey,
      ),
      spCertificate: keys.certificate,
    };
  }

  /**
   * Whoever maps a group to a role, or gives one to just-in-time members,
   * must be able to grant it themselves (the access API's rule): else
   * `Access.manageSso` and an IdP of one's own would hand out any role.
   * `kept`: the roles already mapped, when the IdP itself changes.
   */
  private async checkRoles(
    actor: UserPrincipal,
    input: Partial<Pick<RoleSetup, 'roleMappings' | 'defaultRoleIds'>>,
    kept: readonly string[] = [],
  ) {
    const roleIds = [
      ...(input.roleMappings ?? []).map((mapping) => mapping.roleId),
      ...(input.defaultRoleIds ?? []),
      ...kept,
    ];
    if (roleIds.length > 0) {
      await this.roles.checkRoleGrant(actor, [...new Set(roleIds)]);
    }
  }

  /** Replaces what was sent of a connection's role mappings (in its transaction). */
  private async writeRoleSetup(
    connectionId: string,
    input: Partial<Pick<RoleSetup, 'roleMappings' | 'defaultRoleIds'>>,
  ) {
    const rows: { group: string | null; roleId: string }[] = [];
    if (input.roleMappings !== undefined) {
      await this.repository.deleteRoleMappings(connectionId, true);
      rows.push(...input.roleMappings);
    }
    if (input.defaultRoleIds !== undefined) {
      await this.repository.deleteRoleMappings(connectionId, false);
      rows.push(
        ...input.defaultRoleIds.map((roleId) => ({ group: null, roleId })),
      );
    }
    if (rows.length > 0) {
      await this.repository.insertRoleMappings(connectionId, rows);
    }
  }

  /** The role setups of these connections, by connection. */
  private async roleSetups(connectionIds: string[]) {
    const setups = new Map<string, RoleSetup>();
    if (connectionIds.length === 0) {
      return setups;
    }
    const rows = await this.repository.roleMappingsOfAll(connectionIds);
    for (const row of rows) {
      const setup = setups.get(row.connectionId) ?? {
        roleMappings: [],
        defaultRoleIds: [],
      };
      if (row.group === null) {
        setup.defaultRoleIds.push(row.roleId);
      } else {
        setup.roleMappings.push({ group: row.group, roleId: row.roleId });
      }
      setups.set(row.connectionId, setup);
    }
    return setups;
  }

  private async queueDiscovery(connectionId: string) {
    await this.queue.add(
      'oidc-discovery',
      withTenant({ kind: 'oidc-discovery' as const, connectionId }),
    );
  }

  /**
   * An URL the app will reach or send browsers to: https, or http on a
   * loopback host with SSO_ALLOW_LOOPBACK (development, tests). Where it
   * resolves to is checked when it is fetched (core/http/safe-fetch.ts).
   */
  private checkUrl(value: string, field: string) {
    const url = new URL(value);
    const loopback = this.config.allowLoopback;
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: `${field} must be an https:// URL.`,
        errors: [{ path: field, message: 'An https:// URL.' }],
      });
    }
    if (url.username || url.password) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: `${field} carries credentials.`,
        errors: [{ path: field, message: 'No user name or password in it.' }],
      });
    }
    return value;
  }

  private async find(id: string) {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(id);
    }
    return row;
  }

  /** What an administrator sees: never the client secret nor our private key. */
  private view(row: SsoConnection, roles?: RoleSetup) {
    const { roleMappings, defaultRoleIds }: RoleSetup = roles ?? {
      roleMappings: [],
      defaultRoleIds: [],
    };
    const urls = this.urls(row);
    return {
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      enabled: row.enabled,
      jitProvisioning: row.jitProvisioning,
      groupsAttribute: row.groupsAttribute,
      roleMappings,
      defaultRoleIds,
      loginUrl: urls.login,
      oidc:
        row.protocol === 'oidc'
          ? {
              issuer: row.issuer ?? '',
              clientId: row.clientId ?? '',
              redirectUri: urls.oidcCallback,
              metadataFetchedAt: row.metadataFetchedAt,
              metadataError: row.metadataError,
            }
          : null,
      oauth2:
        row.protocol === 'oauth2'
          ? {
              authorizationEndpoint: row.authorizationEndpoint ?? '',
              tokenEndpoint: row.tokenEndpoint ?? '',
              userinfoEndpoint: row.userinfoEndpoint ?? '',
              clientId: row.clientId ?? '',
              tokenEndpointAuthMethod:
                row.tokenEndpointAuthMethod ?? 'client_secret_basic',
              scopes: row.scopes ?? [],
              mapping: row.mapping!,
              preset: row.preset ?? null,
              redirectUri: urls.oauth2Callback,
            }
          : null,
      saml:
        row.protocol === 'saml'
          ? {
              idpEntityId: row.idpEntityId ?? '',
              idpSsoUrl: row.idpSsoUrl ?? '',
              idpCertificates: row.idpCertificates.map(describeCertificate),
              allowIdpInitiated: row.allowIdpInitiated,
              requireEncryptedAssertions: row.requireEncryptedAssertions,
              spCertificate: row.spCertificate
                ? {
                    pem: row.spCertificate,
                    ...describeCertificate(row.spCertificate),
                  }
                : null,
              spEntityId: urls.samlMetadata,
              acsUrl: urls.samlAcs,
              metadataUrl: urls.samlMetadata,
            }
          : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** The role setup of a change, for its audit entry. */
const roleDetails = (
  input: Partial<Pick<RoleSetup, 'roleMappings' | 'defaultRoleIds'>>,
) => ({
  ...(input.roleMappings !== undefined && {
    roleMappings: input.roleMappings,
  }),
  ...(input.defaultRoleIds !== undefined && {
    defaultRoleIds: input.defaultRoleIds,
  }),
});

const isUniqueViolation = (error: unknown) =>
  databaseErrorKind(error) === 'unique_violation';

/** Fields that aren't the connection's protocol's. */
const fieldsRefused = (protocol: string, fields: string[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: `A ${protocol} connection has no ${fields.join(', ')}.`,
    errors: fields.map((path) => ({
      path,
      message: `Not a field of a ${protocol} connection.`,
    })),
  });

/** Fields a connection can't do without. */
const missingFields = (fields: readonly string[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: `Missing: ${fields.join(', ')}.`,
    errors: fields.map((path) => ({ path, message: 'Required.' })),
  });

const notFound = (id: string) =>
  new NotFoundException(`SSO connection ${id} not found.`);

const nameTaken = (name: string) =>
  new ConflictException({
    code: 'sso_connection_name_taken',
    message: `A connection named "${name}" exists.`,
    errors: [{ path: 'name', message: `"${name}" is taken.` }],
  });
