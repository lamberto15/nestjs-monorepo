import { Test } from '@nestjs/testing';
import type { ListQuery } from '../../core/http/list-query.js';
import { AuditService } from '../audit/audit.service.js';
import { SIGN_IN_ACTIONS } from '../audit/sign-in-actions.js';
import { AuditLogRepository } from './audit-log.repository.js';
import { AuditLogService } from './audit-log.service.js';
import { SIGN_IN_LIST } from './audit.lists.js';

/** AuditLogService's views on a stubbed repository: no database. */
describe('AuditLogService', () => {
  const repository = { entries: vi.fn(), signIns: vi.fn() };
  const audit = {
    withActorNames: vi.fn((entries: object[]) =>
      entries.map((entry) => ({ ...entry, actorName: 'Ada' })),
    ),
  };
  let service: AuditLogService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditLogService,
        { provide: AuditLogRepository, useValue: repository },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(AuditLogService);
  });

  it('shows a sign-in entry as a sign-in: its user, result and method', async () => {
    repository.signIns.mockResolvedValue({
      items: [
        {
          id: 'e1',
          at: new Date(0),
          actor: 'user:u1',
          actorLabel: 'ada@example.com',
          action: SIGN_IN_ACTIONS.failed,
          details: { method: 'password', via: 7 },
          ip: '10.0.0.1',
        },
      ],
      nextCursor: null,
    });
    const page = await service.signIns(SIGN_IN_LIST.parse({}) as ListQuery);
    expect(page.items[0]).toMatchObject({
      user: 'user:u1',
      userName: 'Ada',
      result: 'failure',
      method: 'password',
      via: null,
    });
  });
});
