import { Test } from '@nestjs/testing';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { AvatarsService } from '../attachments/avatars/avatars.service.js';
import { PeopleRepository } from './people.repository.js';
import { PeopleService } from './people.service.js';

/** PeopleService's rules on a stubbed repository: no database. */
describe('PeopleService', () => {
  const repository = {
    usersByEmail: vi.fn(),
    memberNames: vi.fn(),
    clientNames: vi.fn(),
    findClient: vi.fn(),
  };
  const users = { inTenant: vi.fn() };
  const avatars = { urlOf: vi.fn() };
  const tenancy = { tenantId: () => 't1' };
  const id = '0190f0a0-0000-7000-8000-000000000001';
  let service: PeopleService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PeopleService,
        { provide: PeopleRepository, useValue: repository },
        { provide: Tenancy, useValue: tenancy },
        { provide: UsersRepository, useValue: users },
        { provide: AvatarsService, useValue: avatars },
      ],
    }).compile();
    service = moduleRef.get(PeopleService);
  });

  it('names a key it cannot resolve null, and asks nothing for a malformed id', async () => {
    repository.memberNames.mockResolvedValue([{ id, name: 'Ada' }]);
    const names = await service.names([`user:${id}`, 'user:nope', 'client:x']);
    expect(repository.memberNames).toHaveBeenCalledWith([id], 't1');
    expect(repository.clientNames).not.toHaveBeenCalled();
    expect([...names]).toEqual([
      [`user:${id}`, 'Ada'],
      ['user:nope', null],
      ['client:x', null],
    ]);
  });

  it('resolves an address only among the keys given', async () => {
    await expect(service.keysOfEmails(['a@x.test'], [])).resolves.toEqual(
      new Map(),
    );
    expect(repository.usersByEmail).not.toHaveBeenCalled();
  });

  it('is no principal for an inactive client', async () => {
    repository.findClient.mockResolvedValue({ id, name: 'c', active: false });
    await expect(service.principal(`client:${id}`)).resolves.toBeNull();
    repository.findClient.mockResolvedValue({ id, name: 'c', active: true });
    await expect(service.principal(`client:${id}`)).resolves.toEqual({
      kind: 'client',
      id,
      name: 'c',
      tenantId: 't1',
    });
  });
});
