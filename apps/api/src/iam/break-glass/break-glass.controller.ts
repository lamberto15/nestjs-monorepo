import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { OperatorOnly } from '../auth/operator-only.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { SessionOnly } from '../auth/user-only.decorator.js';
import { BreakGlassPolicy } from './break-glass.policy.js';
import {
  breakGlassGrantSchema,
  breakGlassGrantsSchema,
  startBreakGlassSchema,
} from './break-glass.schemas.js';
import { BreakGlassService } from './break-glass.service.js';

/**
 * Break-glass grants, the operators' (`Platform.breakGlass`, from their own
 * session in the operators' tenant): open one, list theirs, end one.
 */
@ApiTags('tenants')
@ApiCookieAuth('user-session')
@SessionOnly()
@OperatorOnly()
@Controller('tenants/:id/break-glass')
export class BreakGlassController {
  constructor(private readonly breakGlass: BreakGlassService) {}

  @Post()
  @Can(BreakGlassPolicy, 'breakGlass')
  @RecentAuthentication()
  @ApiOperation({
    summary:
      'Open a break-glass grant to this tenant (read only, at most an hour)',
    description:
      'Audited in both tenants and the tenant’s sign-in log; its administrators are told. Send `Break-Glass: <grant id>` on reads.',
  })
  @ApiCreatedResponse({ standardSchema: breakGlassGrantSchema })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse({ description: '`break_glass_not_allowed`.' })
  @ApiConflictResponse({
    description:
      '`break_glass_active`, `break_glass_own_tenant`, `tenant_inactive`.',
  })
  start(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: startBreakGlassSchema })
    body: z.infer<typeof startBreakGlassSchema>,
    @Ip() ip: string,
  ) {
    return this.breakGlass.start(user, id, body, ip);
  }

  @Get()
  @Can(BreakGlassPolicy, 'breakGlass')
  @ApiOperation({ summary: 'Your break-glass grants to this tenant' })
  @ApiOkResponse({
    standardSchema: breakGlassGrantsSchema,
  })
  async list(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return { items: await this.breakGlass.list(user, id) };
  }

  @Delete(':grantId')
  @Can(BreakGlassPolicy, 'breakGlass')
  @ApiOperation({ summary: 'End your break-glass grant now' })
  @ApiOkResponse({ standardSchema: breakGlassGrantSchema })
  @ApiNotFoundResponse()
  end(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('grantId', ParseUUIDPipe) grantId: string,
    @Ip() ip: string,
  ) {
    return this.breakGlass.end(user, id, grantId, ip);
  }
}
