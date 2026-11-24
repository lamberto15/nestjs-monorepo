import { NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { deliverabilityConfig } from './deliverability.config.js';
import { DeliverabilityRepository } from './deliverability.repository.js';
import { SuppressionsService } from './suppressions.service.js';

/** SuppressionsService's rules on a stubbed repository: no database. */
describe('SuppressionsService', () => {
  const repository = {
    findById: vi.fn(),
    suppressedOf: vi.fn(),
    unsuppress: vi.fn(),
    countSkipped: vi.fn(),
    insertEvent: vi.fn(),
    lockOfAddress: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };
  const audit = { record: vi.fn() };
  const system = { kind: 'system', id: 'mail-intake' } as Principal;
  const config = {
    softBounce: { suppressionHours: 24, threshold: 3, windowHours: 72 },
  };
  const entry = (fields: object) => ({
    id: 's1',
    address: 'a@example.com',
    reason: 'hard_bounce',
    suppressedAt: new Date(),
    softBounces: 0,
    events: 1,
    lastSeenAt: new Date(),
    lastDetail: null,
    ...fields,
  });
  let service: SuppressionsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SuppressionsService,
        { provide: DeliverabilityRepository, useValue: repository },
        { provide: AuditService, useValue: audit },
        { provide: MetricsService, useValue: { collect: vi.fn() } },
        { provide: deliverabilityConfig.KEY, useValue: config },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(SuppressionsService);
  });

  it('answers 404 for an entry that is not listed', async () => {
    repository.findById.mockResolvedValue(undefined);
    await expect(service.findOne('s9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('keeps mail from a hard bounce, lets essential mail through a complaint', async () => {
    repository.suppressedOf.mockResolvedValue([
      entry({ address: 'a@example.com', reason: 'hard_bounce' }),
      entry({ address: 'b@example.com', reason: 'complaint' }),
    ]);
    const verdicts = await service.check(['A@example.com', 'b@example.com'], {
      essential: true,
      mail: 'reset',
    });
    expect([...verdicts.keys()]).toEqual(['a@example.com']);
    expect(repository.countSkipped).toHaveBeenCalledWith(
      ['a@example.com'],
      expect.any(Date),
    );
  });

  it('lets an expired soft-bounce suppression go', async () => {
    repository.suppressedOf.mockResolvedValue([
      entry({
        reason: 'soft_bounce',
        suppressedAt: new Date(Date.now() - 25 * 3_600_000),
      }),
    ]);
    const verdicts = await service.check(['a@example.com'], {
      essential: false,
      mail: 'news',
    });
    expect(verdicts.size).toBe(0);
    expect(repository.unsuppress).toHaveBeenCalledWith(['s1']);
  });

  it('skips a replayed event', async () => {
    repository.insertEvent.mockResolvedValue(undefined);
    await expect(
      service.apply(system, 'ses', 'm1', [
        {
          type: 'hard_bounce',
          address: 'a@example.com',
          occurredAt: new Date().toISOString(),
        },
      ] as never),
    ).resolves.toEqual({ recorded: 0, suppressed: [] });
    expect(repository.lockOfAddress).not.toHaveBeenCalled();
  });

  it('suppresses a new address on a hard bounce, audited', async () => {
    repository.insertEvent.mockResolvedValue({ id: 'e1' });
    repository.lockOfAddress.mockResolvedValue(undefined);
    repository.insert.mockResolvedValue(entry({}));
    await expect(
      service.apply(system, 'ses', 'm1', [
        {
          type: 'hard_bounce',
          address: 'a@example.com',
          occurredAt: new Date().toISOString(),
        },
      ] as never),
    ).resolves.toEqual({ recorded: 1, suppressed: ['a@example.com'] });
    expect(audit.record).toHaveBeenCalledWith(
      system,
      expect.objectContaining({ action: 'mailSuppression.created' }),
    );
  });
});
