import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransactionHost } from '@nestjs-cls/transactional';
import type { OutboxHandlerContext } from '@nestjs/outbox';
import { ClsService, ClsServiceManager } from 'nestjs-cls';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { currentTenantScope } from '../../core/tenancy/tenant-scope.js';
import {
  BREAK_GLASS_NOTIFICATIONS,
  BreakGlassNotices,
} from './notifications.break-glass.js';
import type { NotificationsService } from './notifications.service.js';

const TENANT = '0199a000-0000-7000-8000-00000000000a';

describe('break-glass notices', () => {
  it('tells each administrator of the tenant opened, in that tenant, once', async () => {
    vi.spyOn(ClsServiceManager, 'getClsService').mockReturnValue(
      new ClsService(new AsyncLocalStorage()),
    );
    const seen: unknown[] = [];
    const notify = vi.fn(async (_notification: { data: unknown }) => {
      seen.push(currentTenantScope()?.tenantId);
      return [];
    });
    const txHost = {
      tx: {},
      withTransaction: (work: () => Promise<unknown>) => work(),
    } as unknown as TransactionHost<DatabaseTransactions>;
    const ctx = {
      message: { headers: { tenantId: TENANT } },
      processInTransaction: (_tx: unknown, work: () => Promise<unknown>) =>
        work(),
    } as unknown as OutboxHandlerContext;
    const notices = new BreakGlassNotices(
      { notify } as unknown as NotificationsService,
      txHost,
    );
    const event = {
      grantId: 'g1',
      operator: { id: 'o1', email: 'ops@example.com' },
      reason: 'Incident 42: their exports fail',
      expiresAt: '2026-11-18T10:00:00.000Z',
      administrators: ['a1', 'a2'],
    };

    await notices.started(event, ctx);
    expect(notify).toHaveBeenCalledWith({
      type: 'security.break-glass-started',
      to: [
        { kind: 'user', id: 'a1' },
        { kind: 'user', id: 'a2' },
      ],
      data: {
        operator: 'ops@example.com',
        reason: event.reason,
        expiresAt: event.expiresAt,
      },
      key: 'break-glass:g1',
    });
    expect(seen).toEqual([TENANT]);
    expect(
      BREAK_GLASS_NOTIFICATIONS[0].data.parse(notify.mock.calls[0]![0].data),
    ).toBeTruthy();

    await notices.started({ ...event, administrators: [] }, ctx);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
