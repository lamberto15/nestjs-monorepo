import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Principal } from '../../iam/auth/principal.js';
import {
  MAX_RECENTS,
  RECENTS_RETENTION_DAYS,
  type RecordRecentDto,
  recentListSchema,
  recentSchema,
  recordRecentSchema,
} from './recents.schemas.js';
import { RecentsService } from './recents.service.js';

/**
 * The caller's recently opened records, newest first. Anyone signed in keeps
 * their own; a record is noted and listed only while they can read it.
 */
@ApiTags('recents')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Each person's own; what an entry points at is checked against their permissions.
@Controller('recents')
export class RecentsController {
  constructor(private readonly recents: RecentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Your recently opened records',
    description: `Newest first, at most ${MAX_RECENTS}, none older than ${RECENTS_RETENTION_DAYS} days. A record you no longer see (deleted, or your access changed) is left out.`,
  })
  @ApiOkResponse({ standardSchema: recentListSchema })
  list(@CurrentUser() user: Principal) {
    return this.recents.list(user);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Note that you opened a record',
    description: `Puts it first (opening it again moves it up, it is not listed twice). \`label\` is the title the page showed; send no field content. The ${MAX_RECENTS + 1}th oldest drops out.`,
  })
  @ApiOkResponse({ standardSchema: recentSchema })
  @ApiBadRequestResponse({
    description: 'A malformed entry (validation_failed).',
  })
  @ApiNotFoundResponse({
    description: 'No such record, or you may not see it.',
  })
  record(
    @CurrentUser() user: Principal,
    @Body({ schema: recordRecentSchema }) dto: RecordRecentDto,
  ) {
    return this.recents.record(user, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Clear your history',
    description: 'Removes every recent record of yours in this tenant.',
  })
  @ApiNoContentResponse()
  async clear(@CurrentUser() user: Principal) {
    await this.recents.clear(user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove one recent record' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Not one of your recent records.' })
  async remove(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.recents.remove(user, id);
  }
}
