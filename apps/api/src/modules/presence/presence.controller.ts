import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import {
  presenceBodySchema,
  presenceListSchema,
  PRESENCE_BEAT_SECONDS,
  PRESENCE_TTL_SECONDS,
} from './presence.schemas.js';
import { PresenceService } from './presence.service.js';

/**
 * Who is viewing or editing a record now. Anyone who may read the record
 * sees the others and announces themselves; nobody else learns it exists.
 * `@Can.Anyone()`: the permission is the record's, checked per record
 * (PresenceRecords).
 */
@ApiTags('presence')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@Can.Anyone()
@Controller('presence')
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Get(':subject/:recordId')
  @ApiOperation({
    summary: 'Who is on a record now',
    description:
      "The people viewing or editing it, advisory only: saving is still guarded by the record's ETag.",
  })
  @ApiOkResponse({ standardSchema: presenceListSchema })
  @ApiNotFoundResponse({
    description: 'No such record, or you may not see it.',
  })
  list(
    @CurrentUser() user: RequestPrincipal,
    @Param('subject') subject: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
  ) {
    return this.presence.list(user, { subject, recordId });
  }

  @Put(':subject/:recordId')
  @ApiOperation({
    summary: 'Say you are viewing or editing a record',
    description: `Beat every ${PRESENCE_BEAT_SECONDS} seconds while the page is open; you drop out ${PRESENCE_TTL_SECONDS} seconds after the last beat. Send the mode only, never what is being typed. Answers with the list, as GET does. Others on the record hear \`record.presence\` (ids only) when you arrive or change mode.`,
  })
  @ApiOkResponse({ standardSchema: presenceListSchema })
  @ApiNotFoundResponse({
    description: 'No such record, or you may not see it.',
  })
  beat(
    @CurrentUser() user: RequestPrincipal,
    @Param('subject') subject: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body({ schema: presenceBodySchema })
    body: z.infer<typeof presenceBodySchema>,
  ) {
    return this.presence.beat(user, { subject, recordId }, body.mode);
  }

  @Delete(':subject/:recordId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Say you left a record' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description: 'No such record, or you may not see it.',
  })
  async leave(
    @CurrentUser() user: RequestPrincipal,
    @Param('subject') subject: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
  ) {
    await this.presence.leave(user, { subject, recordId });
  }
}
