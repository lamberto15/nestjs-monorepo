import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { CalendarsRepository } from './calendars.repository.js';
import { MAX_CALENDARS } from './calendars.schemas.js';
import { CalendarsService } from './calendars.service.js';

/** CalendarsService's rules on a stubbed repository: no database. */
describe('CalendarsService', () => {
  const repository = {
    findById: vi.fn(),
    count: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };
  const audit = { record: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const row = {
    id: 'c1',
    name: 'Office',
    timezone: 'UTC',
    hours: [{ weekday: 1, start: '09:00', end: '17:00' }],
    exceptions: [],
    version: 3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  let service: CalendarsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CalendarsService,
        { provide: CalendarsRepository, useValue: repository },
        { provide: AuditService, useValue: audit },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(CalendarsService);
  });

  it('answers 404 for a calendar the tenant does not have', async () => {
    repository.findById.mockResolvedValue(undefined);
    await expect(service.findOne('c9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it(`refuses more than ${MAX_CALENDARS} calendars`, async () => {
    repository.count.mockResolvedValue(MAX_CALENDARS);
    await expect(
      service.create(user, { name: 'More' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('renames without a new version, and leaves an unchanged calendar alone', async () => {
    repository.findById.mockResolvedValue(row);
    repository.update.mockResolvedValue({ ...row, name: 'HQ' });
    await service.update(user, 'c1', { name: 'HQ' });
    expect(repository.update).toHaveBeenCalledWith('c1', { name: 'HQ' });

    repository.update.mockClear();
    await service.update(user, 'c1', { timezone: 'UTC' });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('bumps the version when the hours change, audited', async () => {
    repository.findById.mockResolvedValue(row);
    repository.update.mockResolvedValue({ ...row, version: 4 });
    const hours = [{ weekday: 2, start: '08:00', end: '16:00' }];
    await service.update(user, 'c1', { hours } as never);
    expect(repository.update).toHaveBeenCalledWith('c1', {
      hours,
      version: 4,
    });
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ action: 'businessCalendar.updated' }),
    );
  });
});
