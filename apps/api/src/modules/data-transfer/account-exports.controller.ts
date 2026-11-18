import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../../core/http/pagination.js';
import { notWhileImpersonating } from '../../iam/auth/impersonation.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { AccountExports } from './account-exports.service.js';
import { TRANSFER_FORMATS } from './data-transfer.types.js';

const requestSchema = z.object({
  format: z.enum(TRANSFER_FORMATS).default('csv'),
});
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.uuid().optional().describe('`nextCursor` of the previous page.'),
});
const startedSchema = z.object({ id: z.string(), status: z.literal('queued') });
const exportSchema = z.object({
  id: z.string(),
  format: z.enum(TRANSFER_FORMATS),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso
    .datetime()
    .nullable()
    .describe('When it is no longer kept (7 days after it ended).'),
  result: z.object({ rows: z.number(), url: z.url() }).optional(),
  error: z.string().optional(),
});
const pageSchema = z.object({
  items: z.array(exportSchema),
  nextCursor: z.string().nullable(),
});

/**
 * The person's copy of their data. Theirs alone, in any tenant or none;
 * never while an administrator acts as them.
 */
@ApiTags('account')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'Not signed in as a user.' })
@UserOnly()
@Can.Anyone()
@Controller('account')
export class AccountExportsController {
  constructor(private readonly exports: AccountExports) {}

  @Post('export')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'A copy of everything held about you (a background job)',
    description:
      'One row per record: kind (the module), tenantId, id, data (JSON). Follow it at GET /v1/account/exports/{id}, which gives the download link when done.',
  })
  @ApiAcceptedResponse({ standardSchema: startedSchema })
  start(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: requestSchema }) body: z.infer<typeof requestSchema>,
  ) {
    notWhileImpersonating(user);
    return this.exports.start(user, body.format);
  }

  @Get('exports')
  @ApiOperation({
    summary: 'The copies of your data you asked for',
    description:
      'Newest first, by cursor. A completed one has its download link (30 minutes from this answer). Kept 7 days after they end.',
  })
  @ApiOkResponse({ standardSchema: pageSchema })
  list(
    @CurrentUser() user: UserPrincipal,
    @Query({ schema: querySchema }) query: z.infer<typeof querySchema>,
  ) {
    notWhileImpersonating(user);
    return this.exports.list(user, query);
  }

  @Get('exports/:id')
  @ApiOperation({ summary: 'One copy of your data: progress, then its link' })
  @ApiOkResponse({ standardSchema: exportSchema })
  @ApiNotFoundResponse()
  status(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    notWhileImpersonating(user);
    return this.exports.status(user, id);
  }
}
