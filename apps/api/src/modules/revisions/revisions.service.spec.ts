import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuthorizationService } from '@nestjs/authorization';
import { Test } from '@nestjs/testing';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import { RevisionsRepository } from './revisions.repository.js';
import { RevisionsService, UNKNOWN_CHANGER } from './revisions.service.js';

/** RevisionsService's rules on a stubbed repository: no database. */
describe('RevisionsService', () => {
  const repository = {
    last: vi.fn(),
    insert: vi.fn(),
    page: vi.fn(),
    findByNumber: vi.fn(),
  };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  let service: RevisionsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RevisionsService,
        { provide: RevisionsRepository, useValue: repository },
      ],
    })
      // Records, access, authorization and audit: unused by these rules.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(RevisionsService);
  });

  it('writes nothing when nothing changed', async () => {
    repository.last.mockResolvedValue({ number: 3, snapshot: { a: 1 } });
    await service.record('Note', 'n1', { snapshot: { a: 1 }, by: user });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('numbers the next revision and keeps what changed', async () => {
    repository.last.mockResolvedValue({ number: 3, snapshot: { a: 1 } });
    await service.record('Note', 'n1', { snapshot: { a: 2 }, by: user });
    expect(repository.insert).toHaveBeenCalledWith({
      subject: 'Note',
      recordId: 'n1',
      number: 4,
      snapshot: { a: 2 },
      changes: { a: { from: 1, to: 2 } },
      restoredFrom: null,
      changedBy: 'user:user-1',
    });
  });

  it("first keeps the state from before revisions, by 'unknown'", async () => {
    repository.last.mockResolvedValue(undefined);
    repository.insert.mockResolvedValueOnce({ number: 1, snapshot: { a: 1 } });
    await service.record('Note', 'n1', {
      snapshot: { a: 2 },
      before: { a: 1 },
      by: user,
    });
    expect(repository.insert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ number: 1, changedBy: UNKNOWN_CHANGER }),
    );
    expect(repository.insert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ number: 2 }),
    );
  });
});

/** The reads, on a record the principal may read whole. */
describe('RevisionsService, reading', () => {
  const repository = { page: vi.fn(), findByNumber: vi.fn() };
  const row = { id: 'n1', title: 'x' };
  const records = {
    of: () => ({
      store: { findOne: async () => row },
      feature: { policy: class {} },
      declaration: { fields: {} },
    }),
  };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  let service: RevisionsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RevisionsService,
        { provide: RevisionsRepository, useValue: repository },
        { provide: Records, useValue: records },
        { provide: AuthorizationService, useValue: { authorize: vi.fn() } },
        {
          provide: AccessService,
          useValue: { redact: async (...[, , , view]: unknown[]) => view },
        },
        { provide: AuditService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(RevisionsService);
  });

  it('refuses a cursor that is no revision id: 400, before any query', async () => {
    await expect(
      service.list(user, 'Note', 'n1', { cursor: 'nope', limit: 10 } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.page).not.toHaveBeenCalled();
  });

  it('answers 404 for a number outside the column, without asking', async () => {
    await expect(
      service.get(user, 'Note', 'n1', 3_000_000_000),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findByNumber).not.toHaveBeenCalled();
  });
});
