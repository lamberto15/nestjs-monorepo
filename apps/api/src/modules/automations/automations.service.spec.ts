import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { AutomationsRepository } from './automations.repository.js';
import { AutomationsService } from './automations.service.js';

// @Transactional() needs the CLS plugin: here the methods run as written.
vi.mock('@nestjs-cls/transactional', async (actual) => ({
  ...(await actual<object>()),
  Transactional: () => () => undefined,
}));

/** AutomationsService's rules on a stubbed repository: no database. */
describe('AutomationsService', () => {
  const repository = {
    findById: vi.fn(),
    countRunsSince: vi.fn(),
    insertRun: vi.fn(),
    update: vi.fn(),
  };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const rule = {
    id: 'a1',
    version: 3,
    status: 'active',
    failures: 2,
  };
  let service: AutomationsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AutomationsService,
        { provide: AutomationsRepository, useValue: repository },
      ],
    })
      // Records, actions, access, audit, users and tenancy: unused by these rules.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(AutomationsService);
  });

  it('answers 404 for a rule the tenant does not have', async () => {
    repository.findById.mockResolvedValue(undefined);
    await expect(service.get('a9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to activate an active rule', async () => {
    repository.findById.mockResolvedValue(rule);
    await expect(service.activate(user, 'a1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('counts the runs of the last hour', async () => {
    repository.countRunsSince.mockResolvedValue(7);
    await expect(service.recentRuns('a1')).resolves.toBe(7);
    const since = repository.countRunsSince.mock.calls[0]![1] as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(3_600_000);
  });

  it('counts failures in a row, and a success starts over', async () => {
    await expect(
      service.recordRun(rule as never, 'r1', [], 'boom'),
    ).resolves.toBe(3);
    expect(repository.update).toHaveBeenLastCalledWith(
      'a1',
      expect.objectContaining({ lastStatus: 'failed', failures: 3 }),
    );
    await expect(
      service.recordRun(rule as never, 'r1', [], null),
    ).resolves.toBe(0);
    expect(repository.insertRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ ruleVersion: 3, status: 'succeeded' }),
    );
  });
});
