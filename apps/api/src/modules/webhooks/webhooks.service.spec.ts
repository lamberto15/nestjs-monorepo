import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RolesService } from '../../iam/access/roles.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { WebhooksRepository } from './webhooks.repository.js';
import { WebhooksService } from './webhooks.service.js';

/** WebhooksService's rules on a stubbed repository: no database. */
describe('WebhooksService', () => {
  const repository = {
    findClient: vi.fn(),
    roleIdsOfClient: vi.fn(),
    scopeOf: vi.fn(),
    saveScope: vi.fn(),
    deleteScope: vi.fn(),
  };
  const roles = { checkGrant: vi.fn(), permissionsOf: vi.fn() };
  const audit = { record: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  let service: WebhooksService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: WebhooksRepository, useValue: repository },
        { provide: RolesService, useValue: roles },
        { provide: AuditService, useValue: audit },
      ],
    })
      // The package's services and the config: unused by these rules.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(WebhooksService);
  });

  it('reads a client without a scope row as `own`', async () => {
    repository.scopeOf.mockResolvedValue(undefined);
    await expect(service.getScope({ clientId: 'c1' })).resolves.toEqual({
      scope: 'own',
    });
  });

  it('keeps `tenant` and removes the row for `own`, audited only for a user', async () => {
    await service.setScope({ clientId: 'c1' }, 'tenant');
    expect(repository.saveScope).toHaveBeenCalledWith('c1', 'tenant');
    expect(audit.record).not.toHaveBeenCalled();

    await service.setScope({ clientId: 'c1', by: { user } }, 'own');
    expect(repository.deleteScope).toHaveBeenCalledWith('c1');
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        action: 'webhook-scope.updated',
        targetId: 'c1',
      }),
    );
  });

  it('answers 404 for a client the tenant does not have', async () => {
    repository.findClient.mockResolvedValue(undefined);
    await expect(service.delegated(user, 'c9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a user who lacks a permission the client holds: 403 authority_required', async () => {
    repository.findClient.mockResolvedValue({ id: 'c1', name: 'Billing' });
    repository.roleIdsOfClient.mockResolvedValue(['r1']);
    roles.permissionsOf.mockResolvedValue([]);
    roles.checkGrant.mockRejectedValue(new ForbiddenException());
    await expect(service.delegated(user, 'c1')).rejects.toMatchObject({
      response: { code: 'authority_required' },
    });
    expect(roles.permissionsOf).toHaveBeenCalledWith(['r1']);
  });

  it('acts for the user on a client they have authority over', async () => {
    repository.findClient.mockResolvedValue({ id: 'c1', name: 'Billing' });
    repository.roleIdsOfClient.mockResolvedValue([]);
    roles.permissionsOf.mockResolvedValue([]);
    await expect(service.delegated(user, 'c1', '10.0.0.1')).resolves.toEqual({
      clientId: 'c1',
      by: { user, ip: '10.0.0.1' },
    });
  });
});
