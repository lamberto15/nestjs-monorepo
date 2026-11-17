import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import { IdempotentRoute } from '../../core/idempotency/idempotent-route.js';
import type { RequestPrincipal } from '../auth/principal.js';
import { LEGAL_HOLD_LIST } from './holds.lists.js';
import { LegalHoldPolicy } from './holds.policy.js';
import {
  legalHoldPageSchema,
  legalHoldSchema,
  type PlaceLegalHoldDto,
  placeLegalHoldSchema,
  type ReleaseLegalHoldDto,
  releaseLegalHoldSchema,
} from './holds.schemas.js';
import { LegalHoldsService } from './holds.service.js';

/**
 * Legal holds: records kept whatever a retention rule, a delete or an
 * account deletion would do. Everything takes `Access.manageLegalHolds`.
 */
@ApiTags('legal-holds')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('legal-holds')
export class LegalHoldsController {
  constructor(private readonly holds: LegalHoldsService) {}

  @Get()
  @Can(LegalHoldPolicy, 'manageLegalHolds')
  @ApiOperation({
    summary: 'The legal holds, newest first',
    description:
      'Active and released; `?active=true`, `?subject=Note`, `?recordId=`. Cursor pages.',
  })
  @ApiOkResponse({ standardSchema: legalHoldPageSchema })
  async list(@Query({ schema: LEGAL_HOLD_LIST.schema }) query: ListQuery) {
    return LEGAL_HOLD_LIST.pick(await this.holds.list(query), query);
  }

  @Get(':id')
  @Can(LegalHoldPolicy, 'manageLegalHolds')
  @ApiOperation({ summary: 'One legal hold' })
  @ApiOkResponse({ standardSchema: legalHoldSchema })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.holds.get(id);
  }

  @Post()
  @IdempotentRoute()
  @Can(LegalHoldPolicy, 'manageLegalHolds')
  @ApiOperation({
    summary: 'Place a legal hold',
    description:
      'On one record (`recordId`), or on every record of the subject. While it is active the record cannot be deleted (409 `legal_hold`) and is skipped by the retention rules and the recycle bin purge. Audited (`legal-hold.placed`).',
  })
  @ApiCreatedResponse({ standardSchema: legalHoldSchema })
  @ApiBadRequestResponse({
    description: 'An invalid body (validation_failed).',
  })
  place(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: placeLegalHoldSchema }) dto: PlaceLegalHoldDto,
    @Ip() ip: string,
  ) {
    return this.holds.place(user, dto, ip);
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @Can(LegalHoldPolicy, 'manageLegalHolds')
  @ApiOperation({
    summary: 'Release a legal hold',
    description:
      'The hold stays in the list as released. Audited (`legal-hold.released`).',
  })
  @ApiOkResponse({ standardSchema: legalHoldSchema })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'Released already.' })
  release(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: releaseLegalHoldSchema }) dto: ReleaseLegalHoldDto,
    @Ip() ip: string,
  ) {
    return this.holds.release(user, id, dto, ip);
  }
}
