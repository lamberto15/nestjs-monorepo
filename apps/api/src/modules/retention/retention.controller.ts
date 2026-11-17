import { Body, Controller, Get, Ip, Param, Put, Query } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { RetentionPolicy } from './retention.policy.js';
import {
  type PreviewRetentionDto,
  previewRetentionSchema,
  retentionPreviewSchema,
  retentionRuleListSchema,
  retentionRuleSchema,
  type SetRetentionDto,
  setRetentionSchema,
} from './retention.schemas.js';
import { RetentionService } from './retention.service.js';

/**
 * The retention rules modules declare and the tenant's choice for each
 * (`Access.manageRetention`). The purge runs nightly on the queue.
 */
@ApiTags('retention')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('retention/rules')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get()
  @Can(RetentionPolicy, 'manageRetention')
  @ApiOperation({
    summary: 'The retention rules and the tenant’s choice for each',
    description:
      'A declared rule does nothing until the tenant turns it on. `days` is the age after which a record is purged or anonymised (`action`); records under a legal hold are always kept.',
  })
  @ApiOkResponse({ standardSchema: retentionRuleListSchema })
  list() {
    return this.retention.list();
  }

  @Get(':name/preview')
  @Can(RetentionPolicy, 'manageRetention')
  @ApiOperation({
    summary: 'A dry run: what the rule would purge or anonymise now',
    description:
      'Counts the due records and those a legal hold keeps, for the days in force or for `?days=`. Changes nothing.',
  })
  @ApiOkResponse({ standardSchema: retentionPreviewSchema })
  @ApiBadRequestResponse({
    description: 'Days below the rule’s minimum (validation_failed).',
  })
  @ApiNotFoundResponse({ description: 'No rule of this name is declared.' })
  preview(
    @Param('name') name: string,
    @Query({ schema: previewRetentionSchema }) query: PreviewRetentionDto,
  ) {
    return this.retention.preview(name, query.days);
  }

  @Put(':name')
  @Can(RetentionPolicy, 'manageRetention')
  @ApiOperation({
    summary: 'Turn a retention rule on or off, and set its days',
    description:
      'Takes effect at the next nightly run (04:10 UTC). Not below the rule’s `minDays`. Audited (`retention.policy-changed`).',
  })
  @ApiOkResponse({ standardSchema: retentionRuleSchema })
  @ApiBadRequestResponse({
    description:
      'An invalid body, or days below the minimum (validation_failed).',
  })
  @ApiNotFoundResponse({ description: 'No rule of this name is declared.' })
  set(
    @CurrentUser() user: RequestPrincipal,
    @Param('name') name: string,
    @Body({ schema: setRetentionSchema }) dto: SetRetentionDto,
    @Ip() ip: string,
  ) {
    return this.retention.set(user, name, dto, ip);
  }
}
