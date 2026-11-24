import { NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { Events } from '../../core/outbox/events.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { Realtime } from '../realtime/realtime.service.js';
import { NotificationCatalog } from './notifications.catalog.js';
import { NotificationsRepository } from './notifications.repository.js';
import {
  NotificationsService,
  UNREAD_COUNT_CAP,
} from './notifications.service.js';

/** NotificationsService's rules on a stubbed repository: no database. */
describe('NotificationsService', () => {
  const repository = {
    store: vi.fn(),
    countUnread: vi.fn(),
    deleteOf: vi.fn(),
    undeliveredIds: vi.fn(),
    deleteDeliveries: vi.fn(),
    settle: vi.fn(),
  };
  const catalog = {
    declaration: vi.fn(),
    declarations: () => [
      { type: 'security.notice', mandatory: true },
      { type: 'note.shared' },
    ],
  };
  const events = { publish: vi.fn() };
  const realtime = { toPrincipal: vi.fn() };
  let inTransaction = true;
  const user = { kind: 'user', id: 'u1' } as UserPrincipal;
  let service: NotificationsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    inTransaction = true;
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: NotificationsRepository, useValue: repository },
        { provide: NotificationCatalog, useValue: catalog },
        { provide: Events, useValue: events },
        { provide: Realtime, useValue: realtime },
        {
          provide: TransactionHost,
          useValue: {
            withTransaction: (work: () => unknown) => work(),
            isTransactionActive: () => inTransaction,
          },
        },
      ],
    }).compile();
    service = moduleRef.get(NotificationsService);
  });

  it('notifies only inside the change’s transaction', async () => {
    inTransaction = false;
    await expect(
      service.notify({ type: 'note.shared', to: user, data: {} }),
    ).rejects.toThrow(/transaction/);
  });

  it('stores one per recipient, the system skipped, and announces each', async () => {
    catalog.declaration.mockReturnValue({ type: 'note.shared' });
    repository.store.mockResolvedValueOnce('n1');
    const ids = await service.notify({
      type: 'note.shared',
      to: [user, 'system:jobs', 'user:u1'],
      data: { title: 'A' },
    });
    expect(ids).toEqual(['n1']);
    expect(repository.store).toHaveBeenCalledTimes(1);
    expect(repository.store).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: 'user:u1', key: null }),
    );
    expect(events.publish).toHaveBeenCalledTimes(1);
  });

  it('caps the unread count', async () => {
    repository.countUnread.mockResolvedValue(UNREAD_COUNT_CAP + 1);
    await expect(service.unreadCount(user)).resolves.toEqual({
      unread: UNREAD_COUNT_CAP,
      unreadCapped: true,
    });
  });

  it("answers 404 for a notification that isn't the caller's", async () => {
    repository.deleteOf.mockResolvedValue(false);
    await expect(service.remove(user, 'n9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(realtime.toPrincipal).not.toHaveBeenCalled();
  });

  it('settles leaving the mandatory types out', async () => {
    repository.undeliveredIds.mockResolvedValue(['n1']);
    repository.deleteDeliveries.mockResolvedValue(2);
    repository.settle.mockResolvedValue(1);
    await expect(service.settle('user:u1', undefined, 10)).resolves.toEqual({
      notifications: 1,
      messages: 2,
    });
    expect(repository.undeliveredIds).toHaveBeenCalledWith(
      {
        recipient: 'user:u1',
        before: undefined,
        mandatory: ['security.notice'],
      },
      10,
    );
  });
});
