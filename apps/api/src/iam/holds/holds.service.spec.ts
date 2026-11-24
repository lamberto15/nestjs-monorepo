import { TransactionHost } from '@nestjs-cls/transactional';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { LegalHoldsRepository } from './holds.repository.js';
import { LegalHoldsService } from './holds.service.js';

/** LegalHoldsService's rules on a stubbed repository: no database. */
describe('LegalHoldsService', () => {
  const repository = {
    findById: vi.fn(),
    release: vi.fn(),
    activeHoldsOn: vi.fn(),
  };
  const audit = { record: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  let service: LegalHoldsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LegalHoldsService,
        { provide: LegalHoldsRepository, useValue: repository },
        { provide: AuditService, useValue: audit },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(LegalHoldsService);
  });

  it('answers 404 for a hold that is not there, 409 for one released already', async () => {
    repository.release.mockResolvedValue(undefined);
    repository.findById.mockResolvedValue(undefined);
    await expect(service.release(user, 'h1', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    repository.findById.mockResolvedValue({ id: 'h1' });
    await expect(service.release(user, 'h1', {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('holds every record of a subject under a hold without a record', async () => {
    repository.activeHoldsOn.mockResolvedValue([{ recordId: null }]);
    await expect(service.heldAmong('note', ['a', 'b'])).resolves.toEqual(
      new Set(['a', 'b']),
    );
  });

  it('refuses to delete a held record', async () => {
    repository.activeHoldsOn.mockResolvedValue([{ recordId: 'a' }]);
    await expect(
      service.assertNotHeld('note', ['a', 'b']),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'legal_hold' }),
    });
  });

  it('asks nothing for no records', async () => {
    await expect(service.heldAmong('note', [])).resolves.toEqual(new Set());
    expect(repository.activeHoldsOn).not.toHaveBeenCalled();
  });
});
