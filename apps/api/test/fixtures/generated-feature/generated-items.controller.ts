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
 * Generated items: the HTTP routes only. One the caller may not read is the
 * 404 of a missing one; one they read but may not change, a 403. The
 * restore route and the add-ons' routes come with the module's imports.
 */
@ApiTags('generated-items')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('generated-items')
export class GeneratedItemsController {
  constructor(
    private readonly generatedItems: GeneratedItemsService,
    private readonly access: AccessService,
    private readonly authorization: AuthorizationService,
    private readonly presenter: RecordPresenter,
  ) {}

  @Post()
  @Etag()
  @RecordIdempotent(GENERATED_ITEM)
  @Can(GeneratedItemPolicy, 'create')
  @ApiOperation({ summary: 'Create a generated item' })
  @ApiCreatedResponse({ standardSchema: SCHEMAS.response })
  async create(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: SCHEMAS.create }) dto: CreateGeneratedItemDto,
  ) {
    await assertWritableFields(
      this.access,
      user,
      'create',
      GENERATED_ITEM,
      dto,
    );
    return this.presenter.one(
      user,
      await this.generatedItems.create(user, dto),
    );
  }

  @Get()
  @Etag()
  @Can.Anyone() // Only those the caller may read: filtered in the query.
  @ApiOperation({ summary: 'The generated items you may read, newest first' })
  @ApiOkResponse({ standardSchema: pageSchema(SCHEMAS.response) })
  @ApiListQuery(GENERATED_ITEM_LIST)
  @ApiQuery(includeQuery())
  async list(
    @CurrentUser() user: RequestPrincipal,
    @Query() raw: Record<string, unknown>,
    @Query('include', IncludePipe) include: RecordInclude,
  ) {
    const { list, query } = await this.presenter.query(user, raw);
    const page = await this.generatedItems.findPage(user, list, query);
    return this.presenter.page(user, page, { list, query, include });
  }

  @Get(':id')
  @Etag()
  @Can.Anyone() // Checked below, on the record itself.
  @ApiOperation({ summary: 'One generated item' })
  @ApiHeader(ifNoneMatchHeader())
  @ApiQuery(includeQuery())
  @ApiOkResponse({ standardSchema: SCHEMAS.response })
  @ApiNotFoundResponse()
  async get(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('include', IncludePipe) include: RecordInclude,
  ) {
    const row = await this.generatedItems.findOne(id, { visibleTo: user });
    await this.authorization.authorize(GeneratedItemPolicy, 'read', user, row);
    return this.presenter.one(user, row, include);
  }

  @Patch(':id')
  @Etag()
  @Can.Anyone() // Checked below, on the record and on each field.
  @ApiOperation({
    summary: 'Change a generated item: only what is sent changes',
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: SCHEMAS.response })
  @ApiNotFoundResponse()
  @ApiPreconditionFailedResponse({
    description: 'It changed since you read it.',
  })
  async update(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: SCHEMAS.update }) dto: UpdateGeneratedItemDto,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    await this.generatedItems.findOne(id, { visibleTo: user });
    const updated = await this.generatedItems.update(
      user,
      id,
      dto,
      async (row) => {
        await this.authorization.authorize(
          GeneratedItemPolicy,
          'update',
          user,
          row,
        );
        await assertWritableFields(
          this.access,
          user,
          'update',
          GENERATED_ITEM,
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
  @ApiOperation(deleteDocs(GENERATED_ITEM))
  @ApiHeader(ifMatchHeader())
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async delete(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    await this.generatedItems.findOne(id, { visibleTo: user });
    await this.generatedItems.delete(user, id, async (row) => {
      await this.authorization.authorize(
        GeneratedItemPolicy,
        'delete',
        user,
        row,
      );
      assertUnchanged(ifMatch, await this.presenter.one(user, row));
    });
  }
}
