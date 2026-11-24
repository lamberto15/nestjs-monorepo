import { Injectable } from '@nestjs/common';
import type { ListQuery } from '../../core/http/list-query.js';
import { AuditService } from '../audit/audit.service.js';
import { SIGN_IN_ACTIONS } from '../audit/sign-in-actions.js';
import { AuditLogRepository } from './audit-log.repository.js';
import { AUDIT_LIST, SIGN_IN_LIST } from './audit.lists.js';

const stringOf = (value: unknown) => (typeof value === 'string' ? value : null);

/** The audit log and the sign-in log as their pages show them, actors named. */
@Injectable()
export class AuditLogService {
  constructor(
    private readonly repository: AuditLogRepository,
    private readonly audit: AuditService,
  ) {}

  async entries(query: ListQuery) {
    const page = await this.repository.entries(query);
    return AUDIT_LIST.pick(
      { ...page, items: await this.audit.withActorNames(page.items) },
      query,
    );
  }

  async signIns(query: ListQuery) {
    const page = await this.repository.signIns(query);
    const named = await this.audit.withActorNames(page.items);
    return SIGN_IN_LIST.pick(
      {
        ...page,
        items: named.map((entry) => ({
          id: entry.id,
          at: entry.at,
          user: entry.actor,
          userLabel: entry.actorLabel,
          userName: entry.actorName,
          result:
            entry.action === SIGN_IN_ACTIONS.succeeded ? 'success' : 'failure',
          method: stringOf(entry.details?.method),
          via: stringOf(entry.details?.via),
          userAgent: stringOf(entry.details?.userAgent),
          ip: entry.ip,
        })),
      },
      query,
    );
  }
}
