import { SessionService, TokenService } from '@nestjs/authentication';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { TransactionHost } from '@nestjs-cls/transactional';
import { httpConfig } from '../../../core/http/http.config.js';
import { Tenancy } from '../../../core/tenancy/tenancy.service.js';
import { ACCESS_EVENTS } from '../../access/access.events.js';
import { AccessService } from '../../access/access.service.js';
import { RolesService } from '../../access/roles.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { ClientPrincipal } from '../../auth/principal.js';
import { SsoDomainsService } from '../sso-domains.service.js';
import { ScimUsersRepository } from './scim-users.repository.js';
import { ScimUsersService } from './scim-users.service.js';

const ID = '00000000-0000-4000-8000-000000000001';

/** ScimUsersService's rules on a stubbed repository: no database. */
describe('ScimUsersService', () => {
  const repository = {
    provisionedIds: vi.fn(),
    findById: vi.fn(),
    findLink: vi.fn(),
    findByExternalId: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    lockUserByEmail: vi.fn(),
    lockUser: vi.fn(),
    insertUser: vi.fn(),
    deactivateUser: vi.fn(),
    lockMembership: vi.fn(),
    insertMembership: vi.fn(),
    setMembershipActive: vi.fn(),
    hasActiveMembership: vi.fn(),
    isDeprovisioned: vi.fn(),
    markDeprovisioned: vi.fn(),
    unmarkDeprovisioned: vi.fn(),
    activateUser: vi.fn(),
  };
  const domains = { isVerified: vi.fn() };
  const audit = { record: vi.fn() };
  const access = { invalidate: vi.fn() };
  const roles = { assertAnAdministratorRemains: vi.fn() };
  const events = { emit: vi.fn(), emitAsync: vi.fn() };
  const sessions = { revokeAll: vi.fn() };
  const tokens = { revokeAll: vi.fn() };
  const actor = { kind: 'client', tenantId: 't1' } as ClientPrincipal;
  const row = {
    userId: ID,
    externalId: 'ext-1',
    attributes: { userName: 'ada@example.com' },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    email: 'ada@example.com',
    active: true,
  };
  let service: ScimUsersService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ScimUsersService,
        { provide: ScimUsersRepository, useValue: repository },
        { provide: SsoDomainsService, useValue: domains },
        { provide: AuditService, useValue: audit },
        { provide: AccessService, useValue: access },
        { provide: RolesService, useValue: roles },
        { provide: EventEmitter2, useValue: events },
        { provide: Tenancy, useValue: { tenantId: () => 't1' } },
        { provide: httpConfig.KEY, useValue: { appUrl: 'https://app.test' } },
        { provide: SessionService, useValue: sessions },
        { provide: TokenService, useValue: tokens },
        // The transaction is the repository's ambient one: here, none.
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(ScimUsersService);
  });

  it('answers a SCIM User: what the IdP sent, with the server attributes', async () => {
    repository.findById.mockResolvedValue(row);
    await expect(service.get(ID)).resolves.toEqual({
      userName: 'ada@example.com',
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      id: ID,
      externalId: 'ext-1',
      active: true,
      meta: {
        resourceType: 'User',
        created: '1970-01-01T00:00:00.000Z',
        lastModified: '1970-01-01T00:00:00.000Z',
        location: `https://app.test/v1/scim/Users/${ID}`,
      },
    });
  });

  it('answers 404 for an id that is no uuid, without a query', async () => {
    await expect(service.get('nope')).rejects.toMatchObject({ status: 404 });
    expect(repository.findById).not.toHaveBeenCalled();
  });

  it("refuses an address outside the tenant's verified domains", async () => {
    domains.isVerified.mockResolvedValue(false);
    await expect(
      service.create(actor, { userName: 'ada@elsewhere.com' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('refuses to link an account whose address is unproved', async () => {
    domains.isVerified.mockResolvedValue(true);
    repository.lockUserByEmail.mockResolvedValue({
      id: ID,
      active: true,
      emailVerified: false,
    });
    await expect(
      service.create(actor, { userName: 'ada@example.com' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('makes the account and its membership, links it and audits it', async () => {
    domains.isVerified.mockResolvedValue(true);
    repository.lockUserByEmail.mockResolvedValue(undefined);
    repository.insertUser.mockResolvedValue({ id: ID });
    repository.lockMembership.mockResolvedValue(undefined);
    repository.findLink.mockResolvedValue(undefined);
    repository.unmarkDeprovisioned.mockResolvedValue(false);
    repository.findById.mockResolvedValue(row);
    await service.create(actor, {
      userName: 'Ada@Example.com',
      displayName: 'Ada',
    });
    expect(repository.insertUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ada@example.com', name: 'Ada' }),
    );
    expect(repository.insertMembership).toHaveBeenCalledWith('t1', ID);
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ID, externalId: null }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        action: 'scim.user-provisioned',
        details: expect.objectContaining({
          accountCreated: true,
          membershipCreated: true,
        }),
      }),
    );
    expect(access.invalidate).toHaveBeenCalledWith('t1');
  });

  it('deprovisions on DELETE: the membership off, the account too when it has no other, signed out', async () => {
    repository.lockMembership.mockResolvedValue({ active: true });
    repository.findById.mockResolvedValue(row);
    repository.hasActiveMembership.mockResolvedValue(false);
    repository.deactivateUser.mockResolvedValue({ id: ID });
    await service.remove(actor, ID);
    expect(repository.setMembershipActive).toHaveBeenCalledWith(
      't1',
      ID,
      false,
    );
    expect(roles.assertAnAdministratorRemains).toHaveBeenCalled();
    expect(events.emitAsync).toHaveBeenCalledWith(
      ACCESS_EVENTS.memberDeactivated,
      expect.objectContaining({ userId: ID }),
    );
    expect(repository.markDeprovisioned).toHaveBeenCalledWith(ID);
    expect(repository.delete).toHaveBeenCalledWith(ID);
    expect(sessions.revokeAll).toHaveBeenCalledWith(ID);
    expect(tokens.revokeAll).toHaveBeenCalledWith(ID);
    expect(events.emit).toHaveBeenCalledWith(
      ACCESS_EVENTS.memberDeactivationCommitted,
      expect.objectContaining({ userId: ID }),
    );
  });

  it('keeps an account that is still active elsewhere', async () => {
    repository.lockMembership.mockResolvedValue({ active: true });
    repository.findById.mockResolvedValue(row);
    repository.hasActiveMembership.mockResolvedValue(true);
    await service.remove(actor, ID);
    expect(repository.deactivateUser).not.toHaveBeenCalled();
    expect(sessions.revokeAll).not.toHaveBeenCalled();
  });
});
