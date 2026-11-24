import { DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccessService } from '../../iam/access/access.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import { SearchRepository, SNIPPET } from './search.repository.js';
import { SearchService } from './search.service.js';

/** SearchService's rules on a stubbed repository: no database. */
describe('SearchService', () => {
  const repository = { matches: vi.fn() };
  const access = {
    deniedFields: vi.fn(),
    conditionalFields: vi.fn(),
    sqlFilter: vi.fn(),
    redactAll: vi.fn(),
  };
  const declaration = {
    subject: 'Note',
    noun: 'note',
    path: 'notes',
    fields: {
      title: { kind: 'string', options: { searchable: true } },
      body: { kind: 'text', options: { searchable: true } },
    },
  };
  const table = { id: 'id', title: 'title', body: 'body', search: 'search' };
  const records = { all: () => [{ declaration, feature: { table } }] };
  const discovery = { getProviders: () => [] };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  let service: SearchService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: SearchRepository, useValue: repository },
        { provide: AccessService, useValue: access },
        { provide: Records, useValue: records },
        { provide: DiscoveryService, useValue: discovery },
      ],
    }).compile();
    service = moduleRef.get(SearchService);
  });

  it('asks nothing when every searchable field is hidden from the caller', async () => {
    access.deniedFields.mockResolvedValue(['title']);
    access.conditionalFields.mockResolvedValue(['body']);
    await expect(service.search(user, 'q', { limit: 5 })).resolves.toEqual([]);
    expect(repository.matches).not.toHaveBeenCalled();
  });

  it('snippets only a field still shown after redaction, with a match', async () => {
    access.deniedFields.mockResolvedValue([]);
    access.conditionalFields.mockResolvedValue([]);
    const row = {
      id: 'n1',
      title: 'Plan',
      score: '0.5',
      [`${SNIPPET}body`]: 'the <b>plan</b>',
      [`${SNIPPET}title`]: '<b>Plan</b>',
    };
    repository.matches.mockResolvedValue([row]);
    // The body is redacted away.
    access.redactAll.mockResolvedValue([{ ...row }]);
    const [hit] = await service.search(user, 'plan', { limit: 5 });
    expect(repository.matches).toHaveBeenCalledWith(
      table,
      expect.objectContaining({
        vector: 'search',
        snippets: ['body', 'title'],
      }),
    );
    expect(hit).toMatchObject({
      id: 'n1',
      title: 'Plan',
      snippet: '<b>Plan</b>',
      score: 0.5,
      link: '/notes/n1',
      subjectLabel: { singular: 'Note', plural: 'Notes' },
    });
  });
});
