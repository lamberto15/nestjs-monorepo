import { type DynamicModule, Module } from '@nestjs/common';
import {
  Body,
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
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { HoldsModule } from '../../iam/holds/holds.module.js';
import { aNoun, type RecordDeclaration } from '../records/record.js';
import { RECORD, RecordController } from '../records/record-extension.js';
import { relationTitle } from '../records/record-relations.js';
import { RecordsModule } from '../records/records.module.js';
import { MergeExtension } from './merge.extension.js';
import {
  duplicateListSchema,
  type FindDuplicatesDto,
  findDuplicatesSchema,
  type MergeDto,
  mergePreviewSchema,
  mergeSchema,
} from './merge.schemas.js';
import { MERGE_RULES, MergeService } from './merge.service.js';

/** The kinds a rule may match by: money and JSON have no single value to compare. */
const UNMATCHABLE = new Set(['money', 'json']);

/** The rules of a record: the declared ones, else its first string field alone. */
function rulesOf(
  record: RecordDeclaration,
  duplicates?: readonly (readonly string[])[],
) {
  const title = relationTitle(record);
  const rules = (duplicates ?? (title ? [[title]] : [])).filter(
    (rule) => rule.length > 0,
  );
  if (rules.length === 0) {
    throw new Error(
      `${record.subject} takes merge: declare its duplicates rules (no string field to match by default).`,
    );
  }
  for (const name of rules.flat()) {
    const kind = (record.fields[name] as { kind?: string } | undefined)?.kind;
    if (!kind || UNMATCHABLE.has(kind)) {
      throw new Error(
        `${record.subject}: duplicates can't match by "${name}": a field of the record, not money or json.`,
      );
    }
  }
  return rules;
}

/**
 * Duplicates and merging for a record (README.md): `POST /v1/<path>/duplicates`,
 * `GET /v1/<path>/{id}/duplicates`, `POST …/{id}/merge/preview` and
 * `POST …/{id}/merge`. The feature opts in with
 * `MergeModule.forRecord(ITEM, { duplicates: [['email']] })`; the record needs
 * a recycle bin (a merge must be reversible).
 */
@Module({})
export class MergeModule {
  static forRecord(
    record: RecordDeclaration,
    options: { duplicates?: readonly (readonly string[])[] } = {},
  ): DynamicModule {
    if (!record.softDelete) {
      throw new Error(
        `${record.subject} takes merge: it needs softDelete (a merged duplicate goes to the recycle bin).`,
      );
    }
    const rules = rulesOf(record, options.duplicates);
    const nouns = record.path.replace(/-/g, ' ');
    const shown = z.record(z.string(), z.unknown());

    @RecordController(record, '', 'Merge')
    class MergeRoutes {
      constructor(private readonly merges: MergeService) {}

      @Post('duplicates')
      @HttpCode(HttpStatus.OK)
      @Can.Anyone() // Only records the caller may read are searched.
      @ApiOperation({
        summary: `Find ${nouns} like these values`,
        description: `Before creating or changing ${aNoun(record)}: the ${nouns} you may read that its values would duplicate, by the rules (each rule's fields all equal; text without case or surrounding spaces), newest first, at most 20. A match by a field you may not read on a record is no match.`,
      })
      @ApiOkResponse({ standardSchema: duplicateListSchema })
      find(
        @CurrentUser() user: RequestPrincipal,
        @Body({ schema: findDuplicatesSchema }) dto: FindDuplicatesDto,
      ) {
        return this.merges.find(user, dto);
      }

      @Get(':id/duplicates')
      @Can.Anyone() // The record is found as the caller may read it.
      @ApiOperation({
        summary: `The likely duplicates of ${aNoun(record)}`,
        description: `The other ${nouns} you may read matching it by the rules, by its values you may read.`,
      })
      @ApiOkResponse({ standardSchema: duplicateListSchema })
      @ApiNotFoundResponse()
      duplicates(
        @CurrentUser() user: RequestPrincipal,
        @Param('id', ParseUUIDPipe) id: string,
      ) {
        return this.merges.duplicatesOf(user, id);
      }

      @Post(':id/merge/preview')
      @HttpCode(HttpStatus.OK)
      @Can.Anyone() // Checked by MergeService, on both records.
      @ApiOperation({
        summary: `Preview merging a duplicate into ${aNoun(record)}`,
        description:
          'What the merge would do, checked as it checks: the fields you may choose (read on both, change on the survivor), each with both values and whose is kept, the survivor as it would be, and what moves to it. Changes nothing.',
      })
      @ApiOkResponse({ standardSchema: mergePreviewSchema })
      @ApiForbiddenResponse({
        description:
          'You may not change the survivor, delete the duplicate, choose a field (field_forbidden) or change a record referring to the duplicate (merge_references_forbidden).',
      })
      @ApiConflictResponse({
        description: 'The duplicate is under a legal hold (legal_hold).',
      })
      @ApiUnprocessableEntityResponse({
        description:
          'The same record twice (merge_same_record), or the survivor would refer to itself (merge_self_reference).',
      })
      preview(
        @CurrentUser() user: RequestPrincipal,
        @Param('id', ParseUUIDPipe) id: string,
        @Body({ schema: mergeSchema }) dto: MergeDto,
      ) {
        return this.merges.preview(user, id, dto);
      }

      @Post(':id/merge')
      @HttpCode(HttpStatus.OK)
      @Can.Anyone() // Checked by MergeService, on both records.
      @ApiOperation({
        summary: `Merge a duplicate into ${aNoun(record)}`,
        description: `In one transaction, or not at all: the references to the duplicate point at the survivor, the duplicate goes to the recycle bin (restorable: POST /v1/${record.path}/{id}/restore) and the survivor takes the values \`fields\` chooses from it, each through the record's own write (hooks, audit, events). Audited \`.merged\` with what moved, and announced as the domain event of that name so the add-ons that keep rows about it (tags, comments…) move theirs. The checks are the preview's. Answers the survivor.`,
      })
      @ApiOkResponse({ standardSchema: shown })
      @ApiForbiddenResponse({
        description:
          'As the preview: the survivor, the duplicate, a field or a referring record.',
      })
      @ApiConflictResponse({
        description:
          'A legal hold, a hook refusing a write (an approval pending), or a unique value another record holds.',
      })
      @ApiUnprocessableEntityResponse({ description: 'As the preview.' })
      merge(
        @CurrentUser() user: RequestPrincipal,
        @Param('id', ParseUUIDPipe) id: string,
        @Body({ schema: mergeSchema }) dto: MergeDto,
        @Ip() ip: string,
      ) {
        return this.merges.merge(user, id, dto, ip);
      }
    }

    return {
      module: MergeModule,
      imports: [RecordsModule, AccessModule, AuditModule, HoldsModule],
      controllers: [MergeRoutes],
      providers: [
        { provide: RECORD, useValue: record },
        { provide: MERGE_RULES, useValue: rules },
        MergeExtension,
        MergeService,
      ],
    };
  }
}
