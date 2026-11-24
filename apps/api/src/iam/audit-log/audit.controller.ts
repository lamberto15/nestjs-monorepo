import { Controller, Get, Query } from '@nestjs/common';
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
import { AuditLogService } from './audit-log.service.js';
import { AUDIT_LIST, SIGN_IN_LIST } from './audit.lists.js';
import { AuditPolicy } from './audit.policy.js';
import { auditPageSchema, signInPageSchema } from './audit.schemas.js';

/** The audit log and the sign-in log of the tenant: read-only, `Access.readAudit`. */
@ApiTags('access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('access')
export class AuditController {
  constructor(private readonly log: AuditLogService) {}

  @Get('audit')
  @Can(AuditPolicy, 'readAudit')
  @ApiOperation({
    summary: 'The audit log, newest first',
    description:
      "Filter flat (`?action.startsWith=note.&at.gte=2026-01-01T00:00:00Z`) or with `filter` (and/or groups), sort with `sort=action,-at`, pick fields with `fields=at,action,actor`; each parameter lists what it takes. Who acted: by key (`actor=user:<id>`), or by name or address (`actorLabel.contains=ada`: the label the entry stored, a member's name or address, an API client's name; this tenant's only). Each entry names its actor as they are called now (`actorName`; null for `system:<key>`, `anonymous` and deleted accounts) besides the label it stored (`actorLabel`).",
  })
  @ApiOkResponse({ standardSchema: auditPageSchema })
  auditLog(@Query({ schema: AUDIT_LIST.schema }) query: ListQuery) {
    return this.log.entries(query);
  }

  @Get('sign-ins')
  @Can(AuditPolicy, 'readAudit')
  @ApiOperation({
    summary: "The tenant's sign-ins, newest first",
    description:
      "The sign-ins of this tenant's members, successes and wrong passwords (a wrong password to an unknown address is nobody's), as the tenant saw them: a sign-in is entered in the tenant it lands in, so another tenant's administrators never read it. Filter by user (`user=user:<id>`), method (`method=password`, `method.startsWith=oidc:`), result (`result=failure`), `ip` and `at`; sort by `at`. Needs the same permission as the audit log (`Access.readAudit`).",
  })
  @ApiOkResponse({ standardSchema: signInPageSchema })
  signIns(@Query({ schema: SIGN_IN_LIST.schema }) query: ListQuery) {
    return this.log.signIns(query);
  }
}
