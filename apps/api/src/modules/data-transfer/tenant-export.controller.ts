import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Injectable,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can, Policy } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { IdempotentRoute } from '../../core/idempotency/idempotent-route.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { OperatorOnly } from '../../iam/auth/operator-only.js';
import type { Principal, UserPrincipal } from '../../iam/auth/principal.js';
import { RecentAuthentication } from '../../iam/auth/recent-authentication.js';
import { startedSchema } from './data-transfer.schemas.js';
import { DataTransferService } from './data-transfer.service.js';
import { TRANSFER_FORMATS } from './data-transfer.types.js';

/** Who may export a whole tenant: users only, never impersonating (`@OperatorOnly()` on the route too). */
@Policy()
export class TenantExportPolicy {
  constructor(private readonly access: AccessService) {}

  async exportTenants(user: Principal | null) {
    return manager(user) && this.access.can(user, 'exportTenants', 'Access');
  }
}

const exportTenantSchema = z
  .object({ format: z.enum(TRANSFER_FORMATS).default('csv') })
  .strict();

/** Starts a tenant's export for an operator, and tells the exported tenant's own log. */
@Injectable()
export class TenantExports {
  constructor(
    private readonly tenancy: Tenancy,
    private readonly transfers: DataTransferService,
    private readonly audit: AuditService,
  ) {}

  async start(
    operator: UserPrincipal,
    tenantId: string,
    format: (typeof TRANSFER_FORMATS)[number],
    ip?: string,
  ) {
    const tenant = await this.tenancy.find(tenantId);
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found.`);
    const started = await this.transfers.startTenantExport(
      operator,
      tenantId,
      format,
      {
        tenantId,
        slug: tenant.slug,
      },
    );
    const entry = {
      action: 'tenant.export-requested',
      targetType: 'tenant',
      targetId: tenantId,
      details: { slug: tenant.slug, transferId: started.id, format },
      ip,
    };
    await this.audit.record(operator, entry);
    if (tenantId !== operator.tenantId) {
      // Its administrators see that the operators took a copy.
      await this.tenancy.run(tenantId, () =>
        this.audit.record(operator, entry),
      );
    }
    return started;
  }
}

/**
 * A tenant's export, for the operators: every record of it as one file
 * (`kind`, `id`, `data` as JSON), made by a worker on the data transfers'
 * queue, behind a link of 30 minutes. See tenant-export.ts for what is in it.
 */
@ApiTags('tenants')
@Controller('tenants')
@OperatorOnly()
export class TenantExportController {
  constructor(private readonly exports: TenantExports) {}

  @Post(':id/export')
  @Can(TenantExportPolicy, 'exportTenants')
  @RecentAuthentication()
  @IdempotentRoute({ required: false })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Export every record of a tenant (operators)',
    description:
      'Answers 202 with the transfer: follow it at GET /v1/data/transfers/{id} (yours, in your tenant), which gives the file’s link when done (valid 30 minutes; ask again for a new one). One row per record: `kind` (its table; `tenant`, `member` for its members’ accounts), `id`, `data` (JSON); hashes, secrets and encrypted columns are left out, stored files are listed by their rows. Wants a recent sign-in (`reauthentication_required`). Audited (`tenant.export-requested`) in your tenant and in that one.',
  })
  @ApiAcceptedResponse({ standardSchema: startedSchema })
  @ApiNotFoundResponse()
  start(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: exportTenantSchema })
    body: z.infer<typeof exportTenantSchema>,
    @Ip() ip: string,
  ) {
    return this.exports.start(user, id, body.format, ip);
  }
}
