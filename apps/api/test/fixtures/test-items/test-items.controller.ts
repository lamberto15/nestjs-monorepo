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
  type Type,
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
import type { RecordSchemas } from '../../../src/modules/records/record.schemas.js';
import { TEST_ITEM_LIST } from './test-item.list.js';
import { TestItemPolicy } from './test-item.policy.js';
import { TEST_ITEM } from './test-item.record.js';
import type {
  CreateTestItemDto,
  UpdateTestItemDto,
} from './test-item.schemas.js';
import { TestItemsService } from './test-items.service.js';

/**
 * Test items: the HTTP routes only, one service call each; the checks are
 * the service's. The restore route and the add-ons' routes come with the
 * module's imports.
 * Made per testItemsModule(): its bodies and response take what the
 * module's add-ons add (`schemas`).
 */
export function testItemsController(SCHEMAS: RecordSchemas): Type {
  @ApiTags('test-items')
  @ApiBearerAuth('api-key')
  @ApiBearerAuth('user-token')
  @ApiCookieAuth('user-session')
  @ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
  @ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
  @Controller('test-items')
  class TestItemsController {
    constructor(private readonly testItems: TestItemsService) {}

    @Post()
    @Etag()
    @RecordIdempotent(TEST_ITEM)
    @Can(TestItemPolicy, 'create')
    @ApiOperation({ summary: 'Create a test item' })
    @ApiCreatedResponse({ standardSchema: SCHEMAS.response })
    create(
      @CurrentUser() user: RequestPrincipal,
      @Body({ schema: SCHEMAS.create }) dto: CreateTestItemDto,
    ) {
      return this.testItems.create(user, dto);
    }

    @Get()
    @Etag()
    @Can.Anyone() // Only those the caller may read: filtered in the query.
    @ApiOperation({ summary: 'The test items you may read, newest first' })
    @ApiOkResponse({ standardSchema: pageSchema(SCHEMAS.response) })
    @ApiListQuery(TEST_ITEM_LIST)
    @ApiQuery(includeQuery())
    list(
      @CurrentUser() user: RequestPrincipal,
      @Query() raw: Record<string, unknown>,
      @Query('include', IncludePipe) include: RecordInclude,
    ) {
      return this.testItems.findPage(user, raw, include);
    }

    @Get(':id')
    @Etag()
    @Can.Anyone() // The service checks the record itself.
    @ApiOperation({ summary: 'One test item' })
    @ApiHeader(ifNoneMatchHeader())
    @ApiQuery(includeQuery())
    @ApiOkResponse({ standardSchema: SCHEMAS.response })
    @ApiNotFoundResponse()
    get(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Query('include', IncludePipe) include: RecordInclude,
    ) {
      return this.testItems.findOne(user, id, include);
    }

    @Patch(':id')
    @Etag()
    @Can.Anyone() // The service checks the record and each field.
    @ApiOperation({ summary: 'Change a test item: only what is sent changes' })
    @ApiHeader(ifMatchHeader())
    @ApiOkResponse({ standardSchema: SCHEMAS.response })
    @ApiNotFoundResponse()
    @ApiPreconditionFailedResponse({
      description: 'It changed since you read it.',
    })
    update(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: SCHEMAS.update }) dto: UpdateTestItemDto,
      @Headers('if-match') ifMatch: string | undefined,
    ) {
      return this.testItems.update(user, id, dto, ifMatch);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Can.Anyone() // The service checks the record itself.
    @ApiOperation(deleteDocs(TEST_ITEM))
    @ApiHeader(ifMatchHeader())
    @ApiNoContentResponse()
    @ApiNotFoundResponse()
    async delete(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Headers('if-match') ifMatch: string | undefined,
    ) {
      await this.testItems.delete(user, id, ifMatch);
    }
  }
  return TestItemsController;
}
