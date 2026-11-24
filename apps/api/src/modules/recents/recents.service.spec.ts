import { NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import { MAX_RECENTS } from './recents.schemas.js';
import { RecentsRegistry } from './recents.registry.js';
import { RecentsRepository } from './recents.repository.js';
import { RecentsService } from './recents.service.js';

/** RecentsService's rules on a stubbed repository: no database. */
describe('RecentsService', () => {
  const repository = {
    listOf: vi.fn(),
    upsert: vi.fn(),
    countOf: vi.fn(),
    deleteBeyond: vi.fn(),
    deleteOne: vi.fn(),
  };
  const findOne = vi.fn();
  const records = { find: vi.fn(() => ({ store: { findOne } })) };
  const registry = { has: vi.fn(() => true) };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const row = {
    id: 'r1',
    subject: 'invoice',
    recordId: 'i1',
    label: 'Invoice 1',
    viewedAt: new Date('2026-11-01T00:00:00Z'),
  };
  let service: RecentsService;

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RecentsService,
        { provide: RecentsRepository, useValue: repository },
        { provide: Records, useValue: records },
        { provide: RecentsRegistry, useValue: registry },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(RecentsService);
  });

  it('drops the oldest past the bound', async () => {
    repository.upsert.mockResolvedValue(row);
    repository.countOf.mockResolvedValue(MAX_RECENTS + 1);
    await service.record(user, {
      subject: 'invoice',
      recordId: 'i1',
      label: 'Invoice 1',
    });
    expect(repository.deleteBeyond).toHaveBeenCalledWith(
      'user:user-1',
      MAX_RECENTS,
    );
  });

  it('refuses to note a subject that keeps no recents: 404', async () => {
    registry.has.mockReturnValueOnce(false);
    await expect(
      service.record(user, { subject: 'x', recordId: 'i1', label: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it('leaves out what the person no longer sees', async () => {
    repository.listOf.mockResolvedValue([row, { ...row, id: 'r2' }]);
    findOne
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new NotFoundException());
    const { items } = await service.list(user);
    expect(items.map((item) => item.id)).toEqual(['r1']);
  });

  it('answers 404 when there was nothing to remove', async () => {
    repository.deleteOne.mockResolvedValue(false);
    await expect(service.remove(user, 'r9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
