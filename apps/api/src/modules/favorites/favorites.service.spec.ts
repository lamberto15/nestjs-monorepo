import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { FavoritesRepository } from './favorites.repository.js';
import { MAX_FAVORITES } from './favorites.schemas.js';
import { FavoritesService } from './favorites.service.js';

/** FavoritesService's rules on a stubbed repository: no database. */
describe('FavoritesService', () => {
  const repository = {
    listOf: vi.fn(),
    countOf: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    idsOf: vi.fn(),
    setPosition: vi.fn(),
    deleteOfRecords: vi.fn(),
    insertMissing: vi.fn(),
  };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const page = {
    kind: 'page',
    subject: 'home',
    target: '/home',
    label: 'Home',
  };
  let service: FavoritesService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        FavoritesService,
        { provide: FavoritesRepository, useValue: repository },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      // Records, the registry and the views: unused by pages.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(FavoritesService);
  });

  it('adds a page last in the list', async () => {
    repository.countOf.mockResolvedValue({ total: 2, last: 4 });
    repository.insert.mockImplementation((values) => ({
      id: 'f1',
      createdAt: new Date(0),
      ...values,
    }));
    await expect(service.add(user, page as never)).resolves.toMatchObject({
      id: 'f1',
      kind: 'page',
    });
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ position: 5 }),
    );
  });

  it(`refuses more than ${MAX_FAVORITES} favorites`, async () => {
    repository.countOf.mockResolvedValue({ total: MAX_FAVORITES, last: 1 });
    await expect(service.add(user, page as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('answers 404 for a favorite the principal does not have', async () => {
    repository.delete.mockResolvedValue(false);
    await expect(service.remove(user, 'f9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('reorders only with every favorite, once each', async () => {
    repository.idsOf.mockResolvedValue(['a', 'b']);
    await expect(
      service.reorder(user, { ids: ['a', 'a'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.setPosition).not.toHaveBeenCalled();
  });

  it('moves a merged duplicate onto the survivor', async () => {
    repository.deleteOfRecords.mockResolvedValue([
      { id: 'f1', owner: 'user:u', target: 'dup', kind: 'record' },
    ]);
    await service.merge('Note', 'dup', 'keep');
    expect(repository.deleteOfRecords).toHaveBeenCalledWith('Note', ['dup']);
    expect(repository.insertMissing).toHaveBeenCalledWith([
      { owner: 'user:u', target: 'keep', kind: 'record' },
    ]);
  });
});
