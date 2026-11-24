import { ConflictException, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type {
  RequestPrincipal,
  SystemPrincipal,
} from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { RecurrenceRepository } from './recurrence.repository.js';
import { RecurrenceService } from './recurrence.service.js';
import type { RecordScheduleRow } from './recurrence.tables.js';
import { ScheduleTargets } from './recurrence.targets.js';

/** RecurrenceService's rules on a stubbed repository: no database. */
describe('RecurrenceService', () => {
  const repository = {
    findOwn: vi.fn(),
    lock: vi.fn(),
    update: vi.fn(),
    insertRun: vi.fn(),
    findClient: vi.fn(),
  };
  const targets = { find: vi.fn() };
  const access = { can: vi.fn() };
  const audit = { record: vi.fn() };
  const users = { inTenant: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as RequestPrincipal;
  const system = { kind: 'system', id: 'record-schedules' } as SystemPrincipal;
  const now = new Date('2026-11-25T10:00:00Z');
  const schedule = {
    id: 's1',
    owner: 'client:c1',
    tenantId: 't1',
    target: 'notes',
    template: { title: 'Weekly' },
    rrule: 'FREQ=DAILY',
    startDate: '2026-11-01',
    time: '09:00',
    timezone: 'UTC',
    calendarId: null,
    status: 'active',
    occurrences: 0,
    maxOccurrences: null,
    failures: 0,
    nextRunAt: new Date('2026-11-25T09:00:00Z'),
  } as unknown as RecordScheduleRow;
  let service: RecurrenceService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RecurrenceService,
        { provide: RecurrenceRepository, useValue: repository },
        { provide: ScheduleTargets, useValue: targets },
        { provide: AccessService, useValue: access },
        { provide: AuditService, useValue: audit },
        { provide: UsersRepository, useValue: users },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      // The queue, calendars, tenancy and locks: unused by these rules.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(RecurrenceService);
  });

  it("answers 404 for another's schedule, 409 for an ended one", async () => {
    repository.findOwn.mockResolvedValue(undefined);
    await expect(service.get(user, 's9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    repository.findOwn.mockResolvedValue({ ...schedule, status: 'ended' });
    await expect(service.pause(user, 's1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('does nothing with a schedule another worker holds', async () => {
    repository.lock.mockResolvedValue(undefined);
    await expect(service.runDue('s1', now, system)).resolves.toBe('idle');
    expect(repository.lock).toHaveBeenCalledWith('s1', { skipLocked: true });
  });

  it('ends a schedule whose owner is gone', async () => {
    repository.lock.mockResolvedValue(schedule);
    repository.findClient.mockResolvedValue({ active: false });
    await expect(service.runDue('s1', now, system)).resolves.toBe('ended');
    expect(repository.update).toHaveBeenCalledWith('s1', {
      status: 'ended',
      endReason: 'owner_inactive',
      nextRunAt: null,
    });
  });

  it('creates an occurrence once, then moves to the next', async () => {
    const create = vi.fn();
    repository.lock.mockResolvedValue(schedule);
    repository.findClient.mockResolvedValue({ active: true, name: 'c' });
    access.can.mockResolvedValue(true);
    targets.find.mockReturnValue({
      subject: 'Note',
      schema: { safeParse: (data: unknown) => ({ success: true, data }) },
      create,
    });
    repository.insertRun.mockResolvedValue(false);
    await expect(service.runDue('s1', now, system)).resolves.toBe('created');
    // Already made by an earlier try: not made again, the schedule moves on.
    expect(create).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ occurrences: 1, lastStatus: 'created' }),
    );
  });
});
