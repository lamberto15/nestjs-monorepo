import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  Controller,
  Get,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Query,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiFoundResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Principal } from '../../iam/auth/principal.js';
import { documentSchema } from './documents.schemas.js';
import { DocumentsService } from './documents.service.js';

/**
 * The documents a record's route asked for (`POST /v1/notes/{id}/pdf`):
 * their state, then the issued PDF. Asking is on the record's own route,
 * which `DocumentsModule.forRecord()` adds.
 */
@ApiTags('documents')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Checked by the service: whoever may read the record.
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get(':id')
  @ApiOperation({
    summary: 'A document asked for: its state',
    description:
      "Whoever may read its record and every field it shows. `completed`: download it at GET /v1/documents/{id}/download. The requester's realtime connection hears `document.ready { id, subject, recordId }` or `document.failed { id, subject, recordId, error }`.",
  })
  @ApiOkResponse({ standardSchema: documentSchema })
  @ApiNotFoundResponse()
  status(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.documents.status(user, id);
  }

  @Get(':id/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download the issued PDF',
    description:
      'Whoever may read the record and every field the PDF shows now: a 302 to a signed link that works for five minutes. `?inline=true` shows it in the browser.',
  })
  @ApiQuery({ name: 'inline', required: false, type: Boolean })
  @ApiFoundResponse({ description: 'The signed link to the PDF.' })
  @ApiNotFoundResponse({
    description: 'No such document, not issued yet, or not yours to read.',
  })
  async download(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('inline', new ParseBoolPipe({ optional: true })) inline?: boolean,
  ) {
    return {
      url: await this.documents.downloadUrl(user, id, inline ?? false),
      statusCode: 302,
    };
  }
}
