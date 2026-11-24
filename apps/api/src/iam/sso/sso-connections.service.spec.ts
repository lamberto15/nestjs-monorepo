import { getQueueToken } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TransactionHost } from '@nestjs-cls/transactional';
import { httpConfig } from '../../core/http/http.config.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { RolesService } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { SsoAccounts } from './sso-accounts.service.js';
import { SsoConnectionsRepository } from './sso-connections.repository.js';
import { SsoConnectionsService } from './sso-connections.service.js';
import { ssoConfig } from './sso.config.js';
import { SSO_QUEUE } from './sso.queue.js';

/** SsoConnectionsService's rules on a stubbed repository: no database. */
describe('SsoConnectionsService', () => {
  const repository = {
    findById: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    roleMappingsOf: vi.fn(),
    roleMappingsOfAll: vi.fn(),
    deleteRoleMappings: vi.fn(),
    insertRoleMappings: vi.fn(),
  };
  const roles = { checkRoleGrant: vi.fn() };
  const audit = { record: vi.fn() };
  const queue = { add: vi.fn() };
  const accounts = { usersOf: vi.fn(), endSessions: vi.fn() };
  const actor = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const oidc = {
    id: 'c1',
    tenantId: 't1',
    name: 'Okta',
    protocol: 'oidc',
    enabled: true,
    jitProvisioning: false,
    groupsAttribute: null,
    issuer: 'https://idp.example.com',
    clientId: 'client',
    clientSecret: 'encrypted',
    spPrivateKey: null,
    spCertificate: null,
    idpCertificates: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  let service: SsoConnectionsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    repository.roleMappingsOfAll.mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        SsoConnectionsService,
        { provide: SsoConnectionsRepository, useValue: repository },
        { provide: RolesService, useValue: roles },
        { provide: AuditService, useValue: audit },
        { provide: SsoAccounts, useValue: accounts },
        { provide: getQueueToken(SSO_QUEUE), useValue: queue },
        {
          provide: EncryptionService,
          useValue: { encrypt: (_: unknown, value: string) => `enc:${value}` },
        },
        { provide: ssoConfig.KEY, useValue: { allowLoopback: false } },
        { provide: httpConfig.KEY, useValue: { appUrl: 'https://app.test' } },
        // The transaction is the repository's ambient one: here, none.
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(SsoConnectionsService);
  });

  it('answers 404 for a connection the tenant does not have', async () => {
    repository.findById.mockResolvedValue(undefined);
    await expect(service.get('c9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('never shows the client secret, and gives the URLs under APP_URL', async () => {
    repository.findById.mockResolvedValue(oidc);
    repository.roleMappingsOfAll.mockResolvedValue([
      { connectionId: 'c1', group: 'admins', roleId: 'r1' },
      { connectionId: 'c1', group: null, roleId: 'r2' },
    ]);
    const view = await service.get('c1');
    expect(JSON.stringify(view)).not.toContain('encrypted');
    expect(view.loginUrl).toBe('https://app.test/v1/auth/sso/t1/c1/login');
    expect(view.roleMappings).toEqual([{ group: 'admins', roleId: 'r1' }]);
    expect(view.defaultRoleIds).toEqual(['r2']);
  });

  it('creates an OIDC connection with its secret encrypted, audited, then queues discovery', async () => {
    repository.insert.mockImplementation((values: object) =>
      Promise.resolve({ ...oidc, ...values }),
    );
    repository.findById.mockResolvedValue(oidc);
    await service.create(actor, {
      protocol: 'oidc',
      name: 'Okta',
      issuer: 'https://idp.example.com',
      clientId: 'client',
      clientSecret: 'secret',
    } as never);
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: 'enc:secret', enabled: false }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ action: 'sso.connection-created' }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'oidc-discovery',
      expect.objectContaining({ connectionId: 'c1' }),
    );
  });

  it('answers 409 for a name taken (the unique index)', async () => {
    repository.insert.mockRejectedValue(
      Object.assign(new Error('duplicate'), { code: '23505' }),
    );
    await expect(
      service.create(actor, {
        protocol: 'oidc',
        name: 'Okta',
        issuer: 'https://idp.example.com',
        clientId: 'client',
        clientSecret: 'secret',
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses an http:// issuer without SSO_ALLOW_LOOPBACK', async () => {
    await expect(
      service.create(actor, {
        protocol: 'oidc',
        name: 'Okta',
        issuer: 'http://idp.example.com',
        clientId: 'client',
        clientSecret: 'secret',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it("refuses a change naming another protocol's field, and writes nothing", async () => {
    repository.findById.mockResolvedValue(oidc);
    await expect(
      service.update(actor, 'c1', { idpSsoUrl: 'https://x' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('checks the kept roles when the IdP itself changes', async () => {
    repository.findById.mockResolvedValue(oidc);
    repository.roleMappingsOf.mockResolvedValue([
      { group: 'admins', roleId: 'r1' },
    ]);
    roles.checkRoleGrant.mockRejectedValue(new BadRequestException());
    await expect(
      service.update(actor, 'c1', { clientId: 'other' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(roles.checkRoleGrant).toHaveBeenCalledWith(actor, ['r1']);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('ends the sessions a connection signed in once it is turned off', async () => {
    repository.findById.mockResolvedValue(oidc);
    repository.update.mockResolvedValue({ ...oidc, enabled: false });
    accounts.usersOf.mockResolvedValue(['u1']);
    await service.update(actor, 'c1', { enabled: false } as never);
    expect(accounts.endSessions).toHaveBeenCalledWith('c1', ['u1']);
  });

  it('answers 404 for deleting a connection that is not there, and audits nothing', async () => {
    accounts.usersOf.mockResolvedValue([]);
    repository.delete.mockResolvedValue(undefined);
    await expect(service.remove(actor, 'c9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audit.record).not.toHaveBeenCalled();
    expect(accounts.endSessions).not.toHaveBeenCalled();
  });
});
