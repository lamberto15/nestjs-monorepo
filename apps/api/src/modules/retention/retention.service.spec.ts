import { getQueueToken } from '@nestjs/bullmq';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { SystemPrincipal } from '../../iam/auth/principal.js';
import { RecordPurges } from './record-purge.js';
import { RetentionRepository } from './retention.repository.js';
import { type RetentionRule, RetentionRules } from './retention.rules.js';
import {
  RETENTION_BATCH,
  RETENTION_QUEUE,
  RetentionService,
} from './retention.service.js';

/** RetentionService's rules on a stubbed repository: no database. */
describe('RetentionService', () => {
  const rule = {
    name: 'note',
    label: 'Notes',
    subject: 'Note',
    action: 'purge',
    defaultDays: 730,
    minDays: 30,
  } as unknown as RetentionRule;
  const repository = {
    policies: vi.fn(),
    findPolicy: vi.fn(),
    savePolicy: vi.fn(),
    countDue: vi.fn(),
    lockDue: vi.fn(),
    deleteRows: vi.fn(),
    anonymiseRows: vi.fn(),
  };
  const rules = {
    find: (name: string) => (name === 'note' ? rule : undefined),
    all: () => [rule],
  };
  const purges = { forget: vi.fn() };
  const audit = { record: vi.fn() };
  const system = { kind: 'system' } as SystemPrincipal;
  let service: RetentionService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RetentionService,
        { provide: RetentionRepository, useValue: repository },
        { provide: RetentionRules, useValue: rules },
        { provide: RecordPurges, useValue: purges },
        { provide: AuditService, useValue: audit },
        { provide: getQueueToken(RETENTION_QUEUE), useValue: {} },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(RetentionService);
  });

  it('refuses days below the minimum, and an unknown rule', async () => {
    await expect(service.preview('note', 10)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.preview('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('does nothing for a rule the tenant turned off', async () => {
    repository.findPolicy.mockResolvedValue({ enabled: false, days: 30 });
    await expect(service.batch(system, rule, true)).resolves.toEqual({
      count: 0,
      more: false,
    });
    expect(repository.lockDue).not.toHaveBeenCalled();
  });

  it('purges a full batch, forgets what refers to it, audits, and asks for more', async () => {
    const ids = Array.from({ length: RETENTION_BATCH }, (_, i) => `n${i}`);
    repository.findPolicy.mockResolvedValue({ enabled: true, days: 30 });
    repository.lockDue.mockResolvedValue(ids);
    const done = await service.batch(system, rule, false);
    expect(purges.forget).toHaveBeenCalledWith('Note', ids);
    expect(repository.deleteRows).toHaveBeenCalledWith(rule, ids);
    expect(audit.record).toHaveBeenCalledWith(
      system,
      expect.objectContaining({ action: 'retention.purged' }),
    );
    expect(done).toEqual({
      count: RETENTION_BATCH,
      more: true,
      held: undefined,
    });
  });
});
