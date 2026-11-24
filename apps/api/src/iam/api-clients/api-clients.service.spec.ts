import { TransactionHost } from '@nestjs-cls/transactional';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { RolesService } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { ApiClientsRepository } from './api-clients.repository.js';
import { ApiClientsService } from './api-clients.service.js';

/** ApiClientsService's rules on a stubbed repository: no database. */
describe('ApiClientsService', () => {
  const repository = {
    findById: vi.fn(),
    keysOf: vi.fn(),
    liveGrantsOf: vi.fn(),
    roleIdsOf: vi.fn(),
    revokeKey: vi.fn(),
  };
  const roles = { checkGrant: vi.fn(), permissionsOf: vi.fn() };
  const audit = { record: vi.fn() };
  const actor = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const client = {
    id: 'c1',
    name: 'Billing',
    active: true,
    allowedCidrs: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  let service: ApiClientsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ApiClientsService,
        { provide: ApiClientsRepository, useValue: repository },
        { provide: RolesService, useValue: roles },
        { provide: AuditService, useValue: audit },
        { provide: Tenancy, useValue: { tenantId: () => 'tenant-1' } },
        // The transaction is the repository's ambient one: here, none.
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      .useMocker(() => ({ emitAsync: vi.fn(), invalidate: vi.fn() }))
      .compile();
    service = moduleRef.get(ApiClientsService);
  });

  it('answers 404 for a client the tenant does not have', async () => {
    repository.findById.mockResolvedValue(undefined);
    await expect(service.get('c9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('shows a client with its keys, never their hashes, and its live grants', async () => {
    repository.findById.mockResolvedValue(client);
    repository.keysOf.mockResolvedValue([
      { id: 'k1', clientId: 'c1', keyId: 'pub', keyHash: 'secret' },
    ]);
    repository.liveGrantsOf.mockResolvedValue([
      { clientId: 'c1', roleId: 'r1', expiresAt: null },
    ]);
    const view = await service.get('c1');
    expect(view.keys).toEqual([expect.objectContaining({ keyId: 'pub' })]);
    expect(view.keys[0]).not.toHaveProperty('keyHash');
    expect(view.roles).toEqual([{ roleId: 'r1', expiresAt: null }]);
  });

  it('answers 404 for a key that is not live, and audits nothing', async () => {
    repository.findById.mockResolvedValue(client);
    repository.roleIdsOf.mockResolvedValue([]);
    roles.permissionsOf.mockResolvedValue([]);
    repository.revokeKey.mockResolvedValue(undefined);
    await expect(service.revokeKey(actor, 'c1', 'k9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
