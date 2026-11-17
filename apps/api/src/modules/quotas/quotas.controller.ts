import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { OperatorOnly } from '../../iam/auth/operator-only.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import {
  planNameSchema,
  planSchema,
  setPlanSchema,
  setTenantQuotasSchema,
  tenantQuotasSchema,
} from './quotas.schemas.js';
import { QuotaPolicy } from './quotas.policy.js';
import { QuotasService } from './quotas.service.js';

/** The tenant's own use against its limits. */
@ApiTags('quotas')
@Controller('quotas')
export class QuotasController {
  constructor(
    private readonly quotas: QuotasService,
    private readonly tenancy: Tenancy,
  ) {}

  @Get()
  @Can(QuotaPolicy, 'read')
  @ApiOperation({
    summary: 'What your tenant uses against its limits',
    description:
      'Every quota: `used` and `limit` (null: unlimited), and for those that start again each day or month, when. Past a limit, the action is refused with 422 (what a tenant has) or 429 (what it uses per period) `quota_exceeded`.',
  })
  @ApiOkResponse({ standardSchema: tenantQuotasSchema })
  own() {
    return this.quotas.view(this.tenancy.tenantId());
  }
}

/** The operators' plans and per tenant limits. */
@ApiTags('quotas')
@OperatorOnly()
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller()
export class OperatorQuotasController {
  constructor(private readonly quotas: QuotasService) {}

  @Get('quotas/plans')
  @Can(QuotaPolicy, 'setLimits')
  @ApiOperation({ summary: 'The quota plans (operators)' })
  @ApiOkResponse({ standardSchema: planSchema.array() })
  plans() {
    return this.quotas.plans();
  }

  @Put('quotas/plans/:name')
  @Can(QuotaPolicy, 'setLimits')
  @ApiOperation({
    summary: 'Create or replace a quota plan (operators)',
    description:
      'Its limits by quota key. The plan named `default` holds for every tenant on no plan. Audited (`quota.plan-saved`).',
  })
  @ApiOkResponse({ standardSchema: planSchema })
  @ApiBadRequestResponse({ description: 'An unknown quota key.' })
  savePlan(
    @CurrentUser() user: UserPrincipal,
    @Param('name', { schema: planNameSchema }) name: string,
    @Body({ schema: setPlanSchema }) body: z.infer<typeof setPlanSchema>,
    @Ip() ip: string,
  ) {
    return this.quotas.savePlan(user, name, body.limits, ip);
  }

  @Delete('quotas/plans/:name')
  @Can(QuotaPolicy, 'setLimits')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a quota plan (operators)',
    description: 'Its tenants fall back to the default plan.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async deletePlan(
    @CurrentUser() user: UserPrincipal,
    @Param('name', { schema: planNameSchema }) name: string,
    @Ip() ip: string,
  ) {
    await this.quotas.deletePlan(user, name, ip);
  }

  @Get('tenants/:id/quotas')
  @Can(QuotaPolicy, 'setLimits')
  @ApiOperation({
    summary: 'What a tenant uses against its limits (operators)',
  })
  @ApiOkResponse({ standardSchema: tenantQuotasSchema })
  @ApiNotFoundResponse()
  tenant(@Param('id', ParseUUIDPipe) id: string) {
    return this.quotas.view(id);
  }

  @Put('tenants/:id/quotas')
  @Can(QuotaPolicy, 'setLimits')
  @ApiOperation({
    summary: 'Set the plan and limits of a tenant (operators)',
    description:
      'Merged into what it has: a number sets a limit, `null` removes the tenant’s own (its plan’s holds again), a key left out stays. A limit below the current use refuses what is made next; nothing existing is deleted. Audited (`tenant.quotas-changed`) in your tenant and in that one.',
  })
  @ApiOkResponse({ standardSchema: tenantQuotasSchema })
  @ApiBadRequestResponse({ description: 'An unknown quota key or plan.' })
  @ApiNotFoundResponse()
  setTenant(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: setTenantQuotasSchema })
    body: z.infer<typeof setTenantQuotasSchema>,
    @Ip() ip: string,
  ) {
    return this.quotas.setTenantLimits(user, id, body, ip);
  }
}
