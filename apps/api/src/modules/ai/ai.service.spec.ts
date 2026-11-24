import { NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { Realtime } from '../realtime/realtime.service.js';
import { AiRepository } from './ai.repository.js';
import { AI, AI_ERRORS, AiService } from './ai.service.js';

/** AiService's rules on a stubbed repository: no database, no model. */
describe('AiService', () => {
  const repository = { findById: vi.fn(), updateIn: vi.fn() };
  const audit = { record: vi.fn() };
  const realtime = { toPrincipal: vi.fn() };
  const queue = { getJob: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const run = {
    id: 'run-1',
    source: 'notes',
    subject: 'Note',
    recordId: 'r1',
    task: 'summarize',
    requestedBy: 'user:user-1',
    status: 'completed',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  let service: AiService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiService,
        { provide: AiRepository, useValue: repository },
        { provide: AuditService, useValue: audit },
        { provide: Realtime, useValue: realtime },
        { provide: getQueueToken(AI), useValue: queue },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      // The sources, records, models, settings, quotas, config and Redis: unused here.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(AiService);
  });

  it("answers 404 for someone else's run", async () => {
    repository.findById.mockResolvedValue({
      ...run,
      requestedBy: 'user:other',
    });
    await expect(service.status(user, 'run-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('shows a completed run as running until its job has finished', async () => {
    repository.findById.mockResolvedValue(run);
    queue.getJob.mockResolvedValue({ finishedOn: undefined });
    await expect(service.status(user, 'run-1')).resolves.toMatchObject({
      status: 'running',
    });
  });

  it('runs only an open run', async () => {
    repository.updateIn.mockResolvedValue(undefined);
    await expect(
      service.run({ id: 'run-1', principal: user, tenantId: 't1' }, user),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(repository.updateIn).toHaveBeenCalledWith(
      'run-1',
      ['queued', 'running'],
      { status: 'running' },
    );
  });

  it('fails an open run once: audited and told, then nothing', async () => {
    repository.updateIn.mockResolvedValueOnce(run);
    const job = { id: 'run-1', principal: user, tenantId: 't1' };
    await service.fail(job, AI_ERRORS.rejected);
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ action: 'ai.failed' }),
    );
    expect(realtime.toPrincipal).toHaveBeenCalledTimes(1);

    repository.updateIn.mockResolvedValueOnce(undefined);
    await service.fail(job, AI_ERRORS.rejected);
    expect(realtime.toPrincipal).toHaveBeenCalledTimes(1);
  });
});
