import { NotFoundException } from '@nestjs/common';
import { AuthorizationService } from '@nestjs/authorization';
import { Test } from '@nestjs/testing';
import { AccessService } from '../../iam/access/access.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { RecordTitles } from '../records/record-titles.js';
import { Records } from '../records/records.service.js';
import { ListPolicy } from './list.policy.js';
import { ListsRepository } from './lists.repository.js';
import { ListsService } from './lists.service.js';

/** ListsService's rules on a stubbed repository: no database. */
describe('ListsService', () => {
  const repository = { optionIds: vi.fn() };
  const authorization = { authorize: vi.fn() };
  const access = { sqlFilter: vi.fn(), assertQueryFields: vi.fn() };
  const titles = { titleField: vi.fn(), of: vi.fn() };
  const record = { list: {}, declaration: {} };
  const records = { find: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  let service: ListsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ListsService,
        { provide: ListsRepository, useValue: repository },
        { provide: AuthorizationService, useValue: authorization },
        { provide: AccessService, useValue: access },
        { provide: RecordTitles, useValue: titles },
        { provide: Records, useValue: records },
      ],
    })
      // The policies and Nest's discovery: unused by these rules.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(ListsService);
  });

  it('answers 404 for an unknown subject before any permission is asked', async () => {
    await expect(service.describeFor(user, 'Nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.optionsFor(user, 'User', { limit: 20 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(authorization.authorize).not.toHaveBeenCalled();
  });

  it('asks ListPolicy, then gives the options the caller may read, titled', async () => {
    records.find.mockReturnValue(record);
    titles.titleField.mockResolvedValue('name');
    access.sqlFilter.mockResolvedValue('read-filter');
    repository.optionIds.mockResolvedValue(['a', 'b']);
    titles.of.mockResolvedValue(new Map([['a', 'Acme']]));
    await expect(
      service.optionsFor(user, 'Customer', { q: 'ac', limit: 5 }),
    ).resolves.toEqual({
      items: [
        { id: 'a', title: 'Acme' },
        { id: 'b', title: null },
      ],
    });
    expect(authorization.authorize).toHaveBeenCalledWith(
      ListPolicy,
      'read',
      user,
      'Customer',
    );
    expect(repository.optionIds).toHaveBeenCalledWith(record, {
      id: undefined,
      q: 'ac',
      title: 'name',
      filters: [undefined, 'read-filter'],
      limit: 5,
    });
  });

  it('matches nothing for a search without a readable title', async () => {
    records.find.mockReturnValue(record);
    titles.titleField.mockResolvedValue(null);
    await expect(
      service.options(user, 'Customer', { q: 'ac', limit: 5 }),
    ).resolves.toEqual([]);
    expect(repository.optionIds).not.toHaveBeenCalled();
  });
});
