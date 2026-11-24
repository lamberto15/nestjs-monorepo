import { BadRequestException } from '@nestjs/common';
import { OutboxDeadLetters } from '@nestjs/outbox';
import { Test } from '@nestjs/testing';
import { OpsBacklog } from './ops.backlog.js';
import { OpsRepository } from './ops.repository.js';
import { OpsService } from './ops.service.js';

/** OpsBacklog's rules on a stubbed repository: no database. */
describe('OpsBacklog', () => {
  const repository = {
    countByTopic: vi.fn(),
    countLeased: vi.fn(),
    deletePending: vi.fn(),
    deadLetterIds: vi.fn(),
  };
  const deadLetters = { purge: vi.fn(), requeue: vi.fn() };
  const tenant = { tenantId: 't1' } as never;
  let backlog: OpsBacklog;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        OpsBacklog,
        { provide: OpsRepository, useValue: repository },
        { provide: OutboxDeadLetters, useValue: deadLetters },
        { provide: OpsService, useValue: {} },
      ],
    }).compile();
    backlog = moduleRef.get(OpsBacklog);
  });

  it('refuses a tenant scope for mail: a mail job names no tenant', async () => {
    await expect(backlog.discard('mail', tenant)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('previews the outbox only for a tenant, the topics biggest first', async () => {
    repository.countByTopic.mockImplementation(async (table: string) =>
      table === 'messages'
        ? [
            { topic: 'a', count: 1 },
            { topic: 'b', count: 5 },
          ]
        : [],
    );
    repository.countLeased.mockResolvedValue(2);
    const preview = await backlog.preview(tenant);
    expect(preview.mail).toBeNull();
    expect(preview.outbox.leased).toBe(2);
    expect(preview.outbox.pending).toEqual({
      total: 6,
      groups: [
        { topic: 'b', count: 5 },
        { topic: 'a', count: 1 },
      ],
    });
  });

  it('discards pending messages, then dead letters, up to the limit', async () => {
    repository.deletePending.mockResolvedValue(3);
    repository.deadLetterIds.mockResolvedValue(['d1', 'd2']);
    deadLetters.purge.mockResolvedValue(2);
    await expect(backlog.discard('outbox', tenant, 10)).resolves.toEqual({
      count: 5,
      more: false,
    });
    expect(repository.deadLetterIds).toHaveBeenCalledWith(tenant, 7);
  });
});
