import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import {
  type CreateImportMappingDto,
  createImportMappingSchema,
  importMappingListSchema,
  savedImportMappingSchema,
} from './data-transfer.schemas.js';
import { ImportMappingsService } from './import-mappings.service.js';

/**
 * The tenant's saved column mappings of an import. Each route answers 404
 * to someone who may not run the import, as its template does.
 */
@ApiTags('data')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // The import's own permission is checked by every route.
@Controller('data/imports/:name/mappings')
export class ImportMappingsController {
  constructor(private readonly mappings: ImportMappingsService) {}

  @Get()
  @ApiOperation({
    summary: 'The saved column mappings of an import',
    description:
      'The tenant’s, by name. `stale` lists the targets you may no longer import: change them before using the mapping.',
  })
  @ApiOkResponse({ standardSchema: importMappingListSchema })
  @ApiNotFoundResponse({ description: 'Nothing to import by that name.' })
  list(@CurrentUser() user: RequestPrincipal, @Param('name') name: string) {
    return this.mappings.list(user, name);
  }

  @Post()
  @ApiOperation({
    summary: 'Save a column mapping',
    description:
      'Checked as an import would be: every target a column you may fill, none twice. At most 50 per import. Audited (`importMapping.created`).',
  })
  @ApiCreatedResponse({ standardSchema: savedImportMappingSchema })
  @ApiBadRequestResponse({
    description:
      'A target you cannot import, a target twice, or too many saved.',
  })
  @ApiConflictResponse({
    description: 'The name is taken (import_mapping_taken).',
  })
  @ApiNotFoundResponse({ description: 'Nothing to import by that name.' })
  create(
    @CurrentUser() user: RequestPrincipal,
    @Param('name') name: string,
    @Body({ schema: createImportMappingSchema }) dto: CreateImportMappingDto,
    @Ip() ip: string,
  ) {
    return this.mappings.create(user, name, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a saved column mapping',
    description: 'Audited (`importMapping.deleted`).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: RequestPrincipal,
    @Param('name') name: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.mappings.remove(user, name, id, ip);
  }
}
