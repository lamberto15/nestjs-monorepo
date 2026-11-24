import { Test } from '@nestjs/testing';
import { AccessService } from '../../iam/access/access.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { RECORD } from '../records/record-extension.js';
import { Records } from '../records/records.service.js';
import { MergeRepository } from './merge.repository.js';
import { MERGE_RULES, MergeService } from './merge.service.js';

/** MergeService's duplicate search on a stubbed repository: no database. */
describe('MergeService', () => {
  const repository = { matching: vi.fn() };
  const access = { sqlFilter: vi.fn() };
  const accepts = { safeParse: () => ({ success: true }) };
  const record = {
    subject: 'Contact',
    fields: {
      email: { kind: 'string', input: accepts },
      bornAt: { kind: 'datetime', input: accepts },
    },
  };
  const table = { id: 'id' };
  const many = vi.fn();
  const records = {
    of: () => ({ feature: { table }, presenter: { many } }),
  };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  let service: MergeService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MergeService,
        { provide: RECORD, useValue: record },
        { provide: MERGE_RULES, useValue: [['email'], ['bornAt']] },
        { provide: MergeRepository, useValue: repository },
        { provide: AccessService, useValue: access },
        { provide: Records, useValue: records },
      ],
    })
      // Authorization, audit, events and holds: unused by the search.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(MergeService);
  });

  it('asks nothing when no rule has its values', async () => {
    await expect(
      service.find(user, { values: { email: '  ' } }),
    ).resolves.toEqual({ items: [] });
    expect(repository.matching).not.toHaveBeenCalled();
  });

  it('matches text without case or spaces, a date as a date', async () => {
    access.sqlFilter.mockResolvedValue('read-filter');
    repository.matching.mockResolvedValue([]);
    many.mockResolvedValue([]);
    await service.find(user, {
      values: { email: ' Ada@Example.com ', bornAt: '2000-01-01T00:00:00Z' },
      excludeId: 'c1',
    });
    expect(repository.matching).toHaveBeenCalledWith(table, {
      rules: [
        [{ field: 'email', value: 'ada@example.com', text: true }],
        [
          {
            field: 'bornAt',
            value: new Date('2000-01-01T00:00:00Z'),
            text: false,
          },
        ],
      ],
      filter: 'read-filter',
      excludeId: 'c1',
      limit: 20,
    });
  });

  it('keeps a match only by fields the reader sees', async () => {
    access.sqlFilter.mockResolvedValue(undefined);
    repository.matching.mockResolvedValue([
      { id: 'c2', email: 'ada@example.com' },
    ]);
    // The email is hidden from them on that record.
    many.mockResolvedValue([{ id: 'c2' }]);
    await expect(
      service.find(user, { values: { email: 'ada@example.com' } }),
    ).resolves.toEqual({ items: [] });
  });
});
