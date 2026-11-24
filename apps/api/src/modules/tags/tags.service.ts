import { Transactional, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  type Type,
} from '@nestjs/common';
import { AuthorizationService } from '@nestjs/authorization';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type { DatabaseTransactions } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { toPage } from '../../core/http/pagination.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import { TagsRepository } from './tags.repository.js';
import type { CreateTagDto, TagRef, UpdateTagDto } from './tags.schemas.js';
import { TagsRegistry } from './tags.registry.js';
import type { tags } from './tags.tables.js';

type Tag = typeof tags.$inferSelect;

const view = (tag: Tag, usageCount: number) => ({
  ...tag,
  usageCount,
  createdAt: tag.createdAt.toISOString(),
  updatedAt: tag.updatedAt.toISOString(),
});

const ref = ({ id, name, color }: Pick<Tag, 'id' | 'name' | 'color'>) => ({
  id,
  name,
  color,
});

const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/**
 * Tags (labels) on the records that opted in (`TagsModule.forRecord()`).
 * Administrators (`Access.manageTags`) define them per subject; a record's
 * tags are set with `setTags`, shown with `tagsOf` (one query per page).
 * Each write is one transaction with its audit entry.
 */
@Injectable()
export class TagsService {
  constructor(
    private readonly repository: TagsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly registry: TagsRegistry,
    private readonly records: Records,
    private readonly audit: AuditService,
    private readonly authorization: AuthorizationService,
  ) {}

  /** A page of tags, newest first unless the query sorts. */
  async list(query: ListQuery) {
    const [rows, total] = await this.repository.page(query);
    const page = toPage(rows, query, total);
    // How many records carry each tag: one grouped query per page.
    const usage = await this.usageOf(page.items.map((row) => row.id));
    return {
      ...page,
      items: page.items.map((row) => view(row, usage.get(row.id) ?? 0)),
    };
  }

  /** Records carrying each tag, one query for all `ids`. */
  private async usageOf(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.repository.usageOf(ids);
    return new Map(rows.map((row) => [row.tagId, row.count]));
  }

  private async findOne(id: string): Promise<Tag> {
    const tag = await this.repository.findById(id);
    if (!tag) throw new NotFoundException(`Tag ${id} not found.`);
    return tag;
  }

  /** A new tag of a subject that takes tags; a 409 when its name is taken (whatever the case). */
  async create(principal: Principal, dto: CreateTagDto, ip?: string) {
    if (!this.registry.has(dto.subject)) {
      throw invalid([
        {
          path: 'subject',
          message: `"${dto.subject}" takes no tags: one of ${this.registry.subjects().join(', ')}`,
        },
      ]);
    }
    const row = await this.txHost
      .withTransaction(async () => {
        const created = await this.repository.insert({
          subject: dto.subject,
          name: dto.name,
          color: dto.color ?? null,
          description: dto.description || null,
        });
        await this.audit.record(principal, {
          action: 'tag.created',
          targetType: 'tag',
          targetId: created.id,
          details: { subject: dto.subject, name: dto.name },
          ip,
        });
        return created;
      })
      .catch((error: unknown) => {
        throw this.conflict(error, dto.subject, dto.name);
      });
    return view(row, 0);
  }

  /** Renames, recolours or redescribes a tag: only what is sent changes. */
  async update(
    principal: Principal,
    id: string,
    dto: UpdateTagDto,
    ip?: string,
  ) {
    const tag = await this.findOne(id);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateTagDto;
    if (values.description === '') values.description = null;
    if (Object.keys(values).length === 0) {
      return view(tag, (await this.usageOf([id])).get(id) ?? 0);
    }
    const row = await this.txHost
      .withTransaction(async () => {
        const updated = await this.repository.update(id, values);
        await this.audit.record(principal, {
          action: 'tag.updated',
          targetType: 'tag',
          targetId: id,
          details: {
            changes: Object.fromEntries(
              Object.entries(values).map(([key, to]) => [
                key,
                { from: tag[key as keyof Tag] ?? null, to },
              ]),
            ),
          },
          ip,
        });
        return updated;
      })
      .catch((error: unknown) => {
        throw this.conflict(error, tag.subject, values.name ?? tag.name);
      });
    return view(row, (await this.usageOf([id])).get(id) ?? 0);
  }

  /** Deletes a tag: every record loses it (the links cascade). */
  @Transactional()
  async remove(principal: Principal, id: string, ip?: string) {
    const tag = await this.findOne(id);
    await this.repository.delete(id);
    await this.audit.record(principal, {
      action: 'tag.deleted',
      targetType: 'tag',
      targetId: id,
      details: { subject: tag.subject, name: tag.name },
      ip,
    });
  }

  /**
   * PUT /<path>/{id}/tags: the record's tags set by whoever may change it.
   * Unreadable: the 404 of a missing one; readable but not theirs to change:
   * a 403.
   */
  async setRecordTags(
    principal: Principal,
    subject: string,
    recordId: string,
    tagIds: readonly string[],
    ip?: string,
  ) {
    const { store, feature } = this.records.of(subject);
    const row = await store.findOne(recordId, { visibleTo: principal });
    await this.authorization.authorize(
      feature.policy as unknown as Type<{
        update(...args: unknown[]): boolean;
      }>,
      'update',
      principal,
      row,
    );
    return {
      items: await this.setTags(principal, subject, recordId, tagIds, ip),
    };
  }

  /**
   * Replaces a record's tags with `tagIds`, in one transaction with one
   * audit entry (`tags.changed`, from and to): a 400 naming each id that is
   * not a tag of the record's subject. The caller has checked the record is
   * theirs to change. Returns the record's tags.
   */
  @Transactional()
  async setTags(
    principal: Principal,
    subject: string,
    recordId: string,
    tagIds: readonly string[],
    ip?: string,
  ): Promise<TagRef[]> {
    const wanted = [...new Set(tagIds)];
    // One change of a record's set at a time: two at once would merge their
    // sets and each audit a `to` that isn't. The record's row is the lock.
    await this.repository.lockRecord(this.records.of(subject), recordId);
    // Shared locks: a tag deleted meanwhile would fail the insert (a 500, not the 400).
    const known = new Set(
      wanted.length ? await this.repository.lockTags(subject, wanted) : [],
    );
    const unknown = tagIds
      .map((id, index) => ({ id, index }))
      .filter(({ id }) => !known.has(id));
    if (unknown.length) {
      throw invalid(
        unknown.map(({ id, index }) => ({
          path: `tagIds.${index}`,
          message: `No ${subject} tag ${id}`,
        })),
      );
    }
    const before = await this.repository.tagIdsOf(subject, recordId);
    const added = wanted.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !wanted.includes(id));
    if (removed.length) {
      await this.repository.unlinkExcept(subject, recordId, wanted);
    }
    if (added.length) {
      await this.repository.link(subject, recordId, added);
    }
    if (added.length || removed.length) {
      await this.audit.record(principal, {
        action: 'tags.changed',
        targetType: subject.charAt(0).toLowerCase() + subject.slice(1),
        targetId: recordId,
        details: { subject, from: before, to: wanted, added, removed },
        ip,
      });
    }
    return (await this.tagsOf(subject, [recordId])).get(recordId)!;
  }

  /**
   * The tags of records of a subject, by record id (every id given has an
   * entry, [] when untagged), by name: one query for a whole page.
   */
  async tagsOf(
    subject: string,
    recordIds: readonly string[],
  ): Promise<Map<string, TagRef[]>> {
    const result = new Map<string, TagRef[]>(
      recordIds.map((id) => [id, []] as [string, TagRef[]]),
    );
    if (recordIds.length) {
      const rows = await this.repository.tagsOf(subject, [
        ...new Set(recordIds),
      ]);
      for (const row of rows) result.get(row.recordId)?.push(ref(row));
    }
    return result;
  }

  /** The ids of the records of `subject` carrying any of `tagIds`: a subquery, for a list filter. */
  idsTagged(subject: string, tagIds: string[]) {
    return this.repository.idsTagged(subject, tagIds);
  }

  /** Records deleted for good take their tags with them. */
  /** A merge: the survivor gains the duplicate's tags (keeping its own). */
  async merge(subject: string, from: string, to: string) {
    await this.repository.moveLinks(subject, from, to);
  }

  async forget(subject: string, recordIds: readonly string[]) {
    await this.repository.unlinkRecords(subject, recordIds);
  }

  private conflict(error: unknown, subject: string, name: string) {
    return databaseErrorKind(error) === 'unique_violation'
      ? new ConflictException({
          code: 'tag_taken',
          message: `A ${subject} tag named "${name}" exists already.`,
        })
      : error;
  }
}
