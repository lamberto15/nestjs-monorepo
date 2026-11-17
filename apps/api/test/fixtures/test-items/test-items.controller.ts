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
import { AuthorizationService, Can } from '@nestjs/authorization';
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
  assertUnchanged,
  Etag,
  ifMatchHeader,
  ifNoneMatchHeader,
} from '../../../src/core/http/etag.js';
import { ApiListQuery } from '../../../src/core/http/list-docs.js';
import { pageSchema } from '../../../src/core/http/pagination.js';
import { AccessService } from '../../../src/iam/access/access.service.js';
import type { RequestPrincipal } from '../../../src/iam/auth/principal.js';
import {
  IncludePipe,
  includeQuery,
  type RecordInclude,
  RecordPresenter,
} from '../../../src/modules/records/record.presenter.js';
import {
  assertWritableFields,
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
 * Test items: the HTTP routes only. A record the caller may not read is
 * the 404 of a missing one; one they read but may not change, a 403. The
 * restore route and the add-ons' routes come with the module's imports.
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
    constructor(
      private readonly testItems: TestItemsService,
      private readonly access: AccessService,
      private readonly authorization: AuthorizationService,
      private readonly presenter: RecordPresenter,
    ) {}

    @Post()
    @Etag()
    @RecordIdempotent(TEST_ITEM)
    @Can(TestItemPolicy, 'create')
    @ApiOperation({ summary: 'Create a test item' })
    @ApiCreatedResponse({ standardSchema: SCHEMAS.response })
    async create(
      @CurrentUser() user: RequestPrincipal,
      @Body({ schema: SCHEMAS.create }) dto: CreateTestItemDto,
    ) {
      await assertWritableFields(this.access, user, 'create', TEST_ITEM, dto);
      return this.presenter.one(user, await this.testItems.create(user, dto));
    }

    @Get()
    @Etag()
    @Can.Anyone() // Only those the caller may read: filtered in the query.
    @ApiOperation({ summary: 'The test items you may read, newest first' })
    @ApiOkResponse({ standardSchema: pageSchema(SCHEMAS.response) })
    @ApiListQuery(TEST_ITEM_LIST)
    @ApiQuery(includeQuery())
    async list(
      @CurrentUser() user: RequestPrincipal,
      @Query() raw: Record<string, unknown>,
      @Query('include', IncludePipe) include: RecordInclude,
    ) {
      const { list, query } = await this.presenter.query(user, raw);
      const page = await this.testItems.findPage(user, list, query);
      return this.presenter.page(user, page, { list, query, include });
    }

    @Get(':id')
    @Etag()
    @Can.Anyone() // Checked below, on the record itself.
    @ApiOperation({ summary: 'One test item' })
    @ApiHeader(ifNoneMatchHeader())
    @ApiQuery(includeQuery())
    @ApiOkResponse({ standardSchema: SCHEMAS.response })
    @ApiNotFoundResponse()
    async get(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Query('include', IncludePipe) include: RecordInclude,
    ) {
      const row = await this.testItems.findOne(id, { visibleTo: user });
      await this.authorization.authorize(TestItemPolicy, 'read', user, row);
      return this.presenter.one(user, row, include);
    }

    @Patch(':id')
    @Etag()
    @Can.Anyone() // Checked below, on the record and on each field.
    @ApiOperation({ summary: 'Change a test item: only what is sent changes' })
    @ApiHeader(ifMatchHeader())
    @ApiOkResponse({ standardSchema: SCHEMAS.response })
    @ApiNotFoundResponse()
    @ApiPreconditionFailedResponse({
      description: 'It changed since you read it.',
    })
    async update(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: SCHEMAS.update }) dto: UpdateTestItemDto,
      @Headers('if-match') ifMatch: string | undefined,
    ) {
      await this.testItems.findOne(id, { visibleTo: user });
      const updated = await this.testItems.update(
        user,
        id,
        dto,
        async (row) => {
          await this.authorization.authorize(
            TestItemPolicy,
            'update',
            user,
            row,
          );
          await assertWritableFields(
            this.access,
            user,
            'update',
            TEST_ITEM,
            dto,
            row,
          );
          assertUnchanged(ifMatch, await this.presenter.one(user, row));
        },
      );
      return this.presenter.one(user, updated);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Can.Anyone() // Checked below, on the record itself.
    @ApiOperation(deleteDocs(TEST_ITEM))
    @ApiHeader(ifMatchHeader())
    @ApiNoContentResponse()
    @ApiNotFoundResponse()
    async delete(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Headers('if-match') ifMatch: string | undefined,
    ) {
      await this.testItems.findOne(id, { visibleTo: user });
      await this.testItems.delete(user, id, async (row) => {
        await this.authorization.authorize(TestItemPolicy, 'delete', user, row);
        assertUnchanged(ifMatch, await this.presenter.one(user, row));
      });
    }
  }
  return TestItemsController;
}
