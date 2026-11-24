import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { I18nService } from '@nestjs/i18n';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AcknowledgmentsRepository } from './acknowledgments.repository.js';
import {
  AcknowledgmentsService,
  REMINDER_INTERVAL_MS,
} from './acknowledgments.service.js';

// @Transactional() needs the CLS plugin: here the methods run as written.
vi.mock('@nestjs-cls/transactional', async (actual) => ({
  ...(await actual<object>()),
  Transactional: () => () => undefined,
}));

/** AcknowledgmentsService's rules on a stubbed repository: no database. */
describe('AcknowledgmentsService', () => {
  const repository = {
    versionOf: vi.fn(),
    lockOfRecipient: vi.fn(),
    markAcknowledged: vi.fn(),
    openOf: vi.fn(),
    markReminded: vi.fn(),
    findOfRecord: vi.fn(),
    delete: vi.fn(),
    userNames: vi.fn(),
  };
  const audit = { record: vi.fn() };
  const notifications = { notify: vi.fn() };
  const user = { kind: 'user', id: 'user-1', name: 'Ann' } as UserPrincipal;
  const record = { subject: 'Note', row: { id: 'r1', title: 'Policy' } };
  const records = {
    of: () => ({ declaration: { noun: 'note', path: 'notes' } }),
  };
  const ack = (fields: object) => ({
    id: 'a1',
    subject: 'Note',
    recordId: 'r1',
    version: 1,
    recipient: 'user:user-1',
    requestedBy: 'user:boss',
    dueAt: null,
    reminders: 0,
    lastRemindedAt: null,
    acknowledgedAt: null,
    createdAt: new Date(0),
    ...fields,
  });
  let service: AcknowledgmentsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    repository.userNames.mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        AcknowledgmentsService,
        { provide: AcknowledgmentsRepository, useValue: repository },
        { provide: AuditService, useValue: audit },
        { provide: NotificationsService, useValue: notifications },
        { provide: I18nService, useValue: { translate: (key: string) => key } },
      ],
    })
      // Records' declarations and access: stubbed where used.
      .useMocker(() => records)
      .compile();
    service = moduleRef.get(AcknowledgmentsService);
  });

  it('counts version 1 while nobody was asked', async () => {
    repository.versionOf.mockResolvedValue(undefined);
    await expect(service.versionOf('Note', 'r1')).resolves.toBe(1);
  });

  it('refuses a deadline in the past', async () => {
    await expect(
      service.request(user, record as never, ['user:u2'], '2000-01-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 404 to someone nobody asked', async () => {
    repository.lockOfRecipient.mockResolvedValue(undefined);
    await expect(
      service.acknowledge(user, record as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('acknowledges again without a change or an audit', async () => {
    repository.lockOfRecipient.mockResolvedValue(
      ack({ acknowledgedAt: new Date(0) }),
    );
    await service.acknowledge(user, record as never);
    expect(repository.markAcknowledged).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('reminds nobody twice within the interval', async () => {
    repository.openOf.mockResolvedValue([
      ack({ id: 'a1', lastRemindedAt: new Date() }),
      ack({
        id: 'a2',
        recipient: 'user:u2',
        lastRemindedAt: new Date(Date.now() - REMINDER_INTERVAL_MS),
      }),
    ]);
    await expect(
      service.remind(user, record as never, undefined),
    ).resolves.toEqual({ reminded: 1, skipped: 1 });
    expect(repository.markReminded).toHaveBeenCalledWith(
      ['a2'],
      expect.any(Date),
    );
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });

  it('keeps a request that was answered', async () => {
    repository.findOfRecord.mockResolvedValue(
      ack({ acknowledgedAt: new Date(0) }),
    );
    await expect(
      service.withdraw(user, record as never, 'a1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.delete).not.toHaveBeenCalled();
  });
});
