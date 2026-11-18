import { Controller, Get, Query } from '@nestjs/common';
import { and } from 'drizzle-orm';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import { AUDIT_LIST, SIGN_IN_LIST } from './audit.lists.js';
import { AuditPolicy } from './audit.policy.js';
import { auditPageSchema, signInPageSchema } from './audit.schemas.js';
import { AuditService } from '../audit/audit.service.js';
import { signInEntries } from '../audit/audit.tables.js';
import { SIGN_IN_ACTIONS } from '../audit/sign-in-actions.js';

const stringOf = (value: unknown) => (typeof value === 'string' ? value : null);

/** The audit log and the sign-in log of the tenant: read-only, `Access.readAudit`. */
@ApiTags('access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('access')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('audit')
  @Can(AuditPolicy, 'readAudit')
  @ApiOperation({
    summary: 'The audit log, newest first',
    description:
      "Filter flat (`?action.startsWith=note.&at.gte=2026-01-01T00:00:00Z`) or with `filter` (and/or groups), sort with `sort=action,-at`, pick fields with `fields=at,action,actor`; each parameter lists what it takes. Who acted: by key (`actor=user:<id>`), or by name or address (`actorLabel.contains=ada`: the label the entry stored, a member's name or address, an API client's name; this tenant's only). Each entry names its actor as they are called now (`actorName`; null for `system:<key>`, `anonymous` and deleted accounts) besides the label it stored (`actorLabel`).",
  })
  @ApiOkResponse({ standardSchema: auditPageSchema })
  async auditLog(@Query({ schema: AUDIT_LIST.schema }) query: ListQuery) {
    const page = await this.audit.page(query, AUDIT_LIST.where(query));
    return AUDIT_LIST.pick(
      { ...page, items: await this.audit.withActorNames(page.items) },
      query,
    );
  }

  @Get('sign-ins')
  @Can(AuditPolicy, 'readAudit')
  @ApiOperation({
    summary: "The tenant's sign-ins, newest first",
    description:
      "The sign-ins of this tenant's members, successes and wrong passwords (a wrong password to an unknown address is nobody's), as the tenant saw them: a sign-in is entered in the tenant it lands in, so another tenant's administrators never read it. Filter by user (`user=user:<id>`), method (`method=password`, `method.startsWith=oidc:`), result (`result=failure`), `ip` and `at`; sort by `at`. Needs the same permission as the audit log (`Access.readAudit`).",
  })
  @ApiOkResponse({ standardSchema: signInPageSchema })
  async signIns(@Query({ schema: SIGN_IN_LIST.schema }) query: ListQuery) {
    const page = await this.audit.page(
      query,
      and(signInEntries, SIGN_IN_LIST.where(query)),
    );
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
