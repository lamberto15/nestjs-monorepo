import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPreconditionFailedResponse,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  Etag,
  ifMatchHeader,
  ifNoneMatchHeader,
} from '../../../src/core/http/etag.js';
import { ApiListQuery } from '../../../src/core/http/list-docs.js';
import { pageSchema } from '../../../src/core/http/pagination.js';
import type { RequestPrincipal } from '../../../src/iam/auth/principal.js';
import {
  IncludePipe,
  includeQuery,
  type RecordInclude,
} from '../../../src/modules/records/record.presenter.js';
import {
  deleteDocs,
  RecordIdempotent,
} from '../../../src/modules/records/record.routes.js';
import { GENERATED_ITEM_LIST } from './generated-item.list.js';
import { GeneratedItemPolicy } from './generated-item.policy.js';
import { GENERATED_ITEM } from './generated-item.record.js';
import {
  GENERATED_ITEM_SCHEMAS,
  type CreateGeneratedItemDto,
  type UpdateGeneratedItemDto,
} from './generated-item.schemas.js';
import { GeneratedItemsService } from './generated-items.service.js';

const SCHEMAS = GENERATED_ITEM_SCHEMAS;

/**
 * Generated items: the HTTP routes only.
 * One service call each; the checks are the service's. The restore route
 * and the add-ons' routes come with the module's imports.
 */
@ApiTags('generated-items')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('generated-items')
export class GeneratedItemsController {
  constructor(private readonly generatedItems: GeneratedItemsService) {}

  @Post()
  @Etag()
  @RecordIdempotent(GENERATED_ITEM)
  @Can(GeneratedItemPolicy, 'create')
  @ApiOperation({ summary: 'Create a generated item' })
  @ApiCreatedResponse({ standardSchema: SCHEMAS.response })
  create(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: SCHEMAS.create }) dto: CreateGeneratedItemDto,
  ) {
    return this.generatedItems.create(user, dto);
  }

  @Get()
  @Etag()
  @Can.Anyone() // Only those the caller may read: filtered in the query.
  @ApiOperation({ summary: 'The generated items you may read, newest first' })
  @ApiOkResponse({ standardSchema: pageSchema(SCHEMAS.response) })
  @ApiListQuery(GENERATED_ITEM_LIST)
  @ApiQuery(includeQuery())
  list(
    @CurrentUser() user: RequestPrincipal,
    @Query() raw: Record<string, unknown>,
    @Query('include', IncludePipe) include: RecordInclude,
  ) {
    return this.generatedItems.findPage(user, raw, include);
  }

  @Get(':id')
  @Etag()
  @Can.Anyone() // The service checks the record itself.
  @ApiOperation({ summary: 'One generated item' })
  @ApiHeader(ifNoneMatchHeader())
  @ApiQuery(includeQuery())
  @ApiOkResponse({ standardSchema: SCHEMAS.response })
  @ApiNotFoundResponse()
  get(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('include', IncludePipe) include: RecordInclude,
  ) {
    return this.generatedItems.findOne(user, id, include);
  }

  @Patch(':id')
  @Etag()
  @Can.Anyone() // The service checks the record and each field.
  @ApiOperation({
    summary: 'Change a generated item: only what is sent changes',
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: SCHEMAS.response })
  @ApiNotFoundResponse()
  @ApiPreconditionFailedResponse({
    description: 'It changed since you read it.',
  })
  update(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: SCHEMAS.update }) dto: UpdateGeneratedItemDto,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    return this.generatedItems.update(user, id, dto, ifMatch);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone() // The service checks the record itself.
  @ApiOperation(deleteDocs(GENERATED_ITEM))
  @ApiHeader(ifMatchHeader())
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async delete(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    await this.generatedItems.delete(user, id, ifMatch);
  }
}
