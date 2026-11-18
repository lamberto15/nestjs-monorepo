import {
  Body,
  type DynamicModule,
  Injectable,
  Ip,
  Module,
  Param,
  ParseUUIDPipe,
  Put,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { inArray } from 'drizzle-orm';
import type { FilterField } from '../../core/http/list-query.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  aNoun,
  type RecordDeclaration,
  type RecordRow,
  type RecordTable,
} from '../records/record.js';
import {
  InjectRecord,
  RECORD,
  RecordController,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import { RecordsModule } from '../records/records.module.js';
import { Records } from '../records/records.service.js';
import { AddTagAction } from './tags.automation.js';
import { TagsController } from './tags.controller.js';
import { TAGS_PERMISSIONS } from './tags.permissions.js';
import { TagsPolicy } from './tags.policy.js';
import { TagsRegistry } from './tags.registry.js';
import {
  type SetTagsDto,
  setTagsSchema,
  tagRefListSchema,
} from './tags.schemas.js';
import { TagsService } from './tags.service.js';

/**
 * What tags add to a record that takes them: `tags` on it, `?tag=<id>` and
 * `?tag.in=<id>,<id>` on its list (the records carrying any of them),
 * `capabilities.tags` in its list's description, and their links removed
 * with the records deleted for good.
 */
@RecordExtension()
@Injectable()
export class TagsExtension implements RecordHooks {
  readonly shows = ['tags'];
  readonly capability = 'tags';

  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly tags: TagsService,
    registry: TagsRegistry,
  ) {
    registry.add(record.subject);
  }

  async present(_principal: Principal, views: Record<string, unknown>[]) {
    const tags = await this.tags.tagsOf(
      this.record.subject,
      views.map((view) => view.id as string),
    );
    return views.map((view) => ({
      ...view,
      tags: tags.get(view.id as string) ?? [],
    }));
  }

  filters(table: RecordTable): Record<string, FilterField> {
    const { subject } = this.record;
    return {
      tag: {
        column: table.id,
        type: 'uuid',
        ops: ['eq', 'in'],
        // The values are tag ids (GET /tags).
        ref: 'tag',
        conditions: {
          eq: (value) =>
            inArray(table.id, this.tags.idsTagged(subject, [value as string])),
          in: (value) =>
            inArray(table.id, this.tags.idsTagged(subject, value as string[])),
        },
      },
    };
  }

  async purged({ ids }: { ids: readonly string[] }) {
    await this.tags.forget(this.record.subject, ids);
  }

  async merged({ from, to }: { from: RecordRow; to: RecordRow }) {
    await this.tags.merge(this.record.subject, from.id, to.id);
  }
}

/**
 * Tags (README.md): the `/tags` routes, the service and its permission,
 * shared by every record that takes them. A feature's module imports
 * `TagsModule.forRecord(RECORD)` for each record.
 */
@Module({
  imports: [
    AccessModule.forFeature(TAGS_PERMISSIONS),
    AuditModule,
    RecordsModule,
  ],
  controllers: [TagsController],
  // AddTagAction: the automations' `addTag` (found by their decorator).
  providers: [TagsService, TagsRegistry, TagsPolicy, AddTagAction],
  exports: [TagsService, TagsRegistry],
})
export class TagsModule {
  /** Tags for one record: its `PUT /<path>/{id}/tags` route and its extension. */
  static forRecord(record: RecordDeclaration): DynamicModule {
    return {
      module: TagsRecordModule,
      imports: [RecordsModule, TagsModule],
      controllers: [tagsRoutes(record)],
      providers: [{ provide: RECORD, useValue: record }, TagsExtension],
    };
  }
}

/** The host of one `TagsModule.forRecord()`. */
@Module({})
class TagsRecordModule {}

/** `PUT /<path>/{id}/tags`: whoever may change the record sets its tags. */
function tagsRoutes(record: RecordDeclaration): Type {
  @RecordController(record, ':id/tags', 'Tags')
  class TagsRoutes {
    constructor(
      private readonly records: Records,
      private readonly tags: TagsService,
      private readonly authorization: AuthorizationService,
    ) {}

    @Put()
    @Can.Anyone() // Checked below: changing the record.
    @ApiOperation({
      summary: `Set ${aNoun(record)}'s tags`,
      description: `Replaces the whole set (\`[]\` removes every tag); the tags must be \`${record.subject}\` tags (GET /v1/tags?subject=${record.subject}). Answers the ${record.noun}'s tags, by name. Audited (\`tags.changed\`, from and to).`,
    })
    @ApiOkResponse({ standardSchema: tagRefListSchema })
    @ApiBadRequestResponse({
      description: `An id that is not a ${record.subject} tag, named by its path (validation_failed).`,
    })
    @ApiForbiddenResponse({
      description: `You may not change the ${record.noun}.`,
    })
    @ApiNotFoundResponse({ description: `No such ${record.noun}.` })
    async set(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: setTagsSchema }) dto: SetTagsDto,
      @Ip() ip: string,
    ) {
      const { store, feature } = this.records.of(record.subject);
      // Unreadable: the 404 of a missing one; readable but not theirs to change: a 403.
      const row = await store.findOne(id, { visibleTo: user });
      await this.authorization.authorize(
        feature.policy as unknown as Type<{
          update(...args: unknown[]): boolean;
        }>,
        'update',
        user,
        row,
      );
      return {
        items: await this.tags.setTags(
          user,
          record.subject,
          id,
          dto.tagIds,
          ip,
        ),
      };
    }
  }
  return TagsRoutes;
}
