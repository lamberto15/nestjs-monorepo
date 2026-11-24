import { Transactional } from '@nestjs-cls/transactional';
import { AuthorizationService } from '@nestjs/authorization';
import {
  ForbiddenException,
  Inject,
  Injectable,
  UnprocessableEntityException,
  type Type,
} from '@nestjs/common';
import { Events } from '../../core/outbox/events.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { LegalHoldsService } from '../../iam/holds/holds.service.js';
import type { AnyField } from '../fields/field.js';
import { writableFields } from '../fields/fields.js';
import {
  type RecordDeclaration,
  recordKey,
  recordValues,
  recordView,
} from '../records/record.js';
import { InjectRecord } from '../records/record-extension.js';
import { relationsFrom, relationsTo } from '../records/record-relations.js';
import { Records } from '../records/records.service.js';
import { mergeEvents } from './merge.events.js';
import { type MatchTerm, MergeRepository } from './merge.repository.js';
import {
  type FindDuplicatesDto,
  MAX_DUPLICATES,
  type MergeDto,
  type MergePreview,
} from './merge.schemas.js';

/** The rules that find a record's duplicates: each the fields whose values must all match. */
export const MERGE_RULES = Symbol('MERGE_RULES');

type Value = string | number | boolean | null;
type Policy = Type<{
  update(...args: unknown[]): boolean;
  delete(...args: unknown[]): boolean;
}>;

const TEXT_KINDS = new Set(['string', 'text']);

/** A value as matching compares it: text without case or surrounding spaces. */
const normalized = (value: unknown) =>
  typeof value === 'string'
    ? value.trim().toLowerCase()
    : value instanceof Date
      ? value.toISOString()
      : String(value);

const filled = (value: unknown) =>
  value !== undefined && value !== null && normalized(value) !== '';

/**
 * A record's duplicates and their merge (README.md): likely duplicates by
 * its rules, among the records the caller may read and by fields they may
 * read; a merge previewed, then done in one transaction through the
 * record's store (hooks, legal hold, audit entries, domain events): the
 * references to the duplicate move to the survivor, the duplicate goes to
 * the recycle bin, the survivor takes the chosen values, `<item>.merged` is
 * audited and published for the add-ons that keep rows about it.
 */
@Injectable()
export class MergeService {
  constructor(
    @InjectRecord() private readonly record: RecordDeclaration,
    @Inject(MERGE_RULES) private readonly rules: readonly (readonly string[])[],
    private readonly repository: MergeRepository,
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
    private readonly events: Events,
    private readonly holds: LegalHoldsService,
  ) {}

  private get registration() {
    return this.records.of(this.record.subject);
  }

  private get table() {
    return this.registration.feature.table;
  }

  private get policy() {
    return this.registration.feature.policy as unknown as Policy;
  }

  private field(name: string) {
    return this.record.fields[name] as AnyField;
  }

  /** A value a rule can match by: given, and one the field takes (else no query could compare it). */
  private usable(name: string, value: unknown) {
    return filled(value) && this.field(name).input.safeParse(value).success;
  }

  /** One rule's terms: each of its fields equal to the value, text as matching compares it. */
  private terms(
    rule: readonly string[],
    values: Record<string, Value>,
  ): MatchTerm[] {
    return rule.map((name) => {
      const value = values[name];
      const kind = this.field(name).kind;
      return TEXT_KINDS.has(kind)
        ? { field: name, value: normalized(value), text: true }
        : {
            field: name,
            value: kind === 'datetime' ? new Date(String(value)) : value,
            text: false,
          };
    });
  }

  /**
   * The live records `principal` may read that match `values` by a rule,
   * newest first: each with the rules it matched on fields the principal
   * may read on it (a match by a hidden field is no match: it would tell
   * the hidden value).
   */
  async find(principal: Principal, { values, excludeId }: FindDuplicatesDto) {
    const rules = this.rules.filter((rule) =>
      rule.every((name) => this.usable(name, values[name])),
    );
    if (rules.length === 0) return { items: [] };
    const rows = await this.repository.matching(this.table, {
      rules: rules.map((rule) => this.terms(rule, values)),
      filter: await this.access.sqlFilter(
        principal,
        this.record.subject,
        'read',
      ),
      excludeId,
      limit: MAX_DUPLICATES,
    });
    const shown = await this.registration.presenter.many(principal, rows);
    const items = rows.flatMap((row, i) => {
      const record = shown[i]!;
      const matched = rules.filter((rule) =>
        rule.every(
          (name) =>
            name in record &&
            normalized(row[name]) === normalized(values[name]),
        ),
      );
      return matched.length ? [{ id: row.id, matched, record }] : [];
    });
    return { items };
  }

  /** The duplicates of a record, by its values the principal may read. */
  async duplicatesOf(principal: Principal, id: string) {
    const row = await this.registration.store.findOne(id, {
      visibleTo: principal,
    });
    const [shown] = await this.registration.presenter.many(principal, [row]);
    const values = Object.fromEntries(
      this.rules
        .flat()
        .filter((name) => name in shown!)
        .map((name) => [name, row[name] as Value]),
    );
    return this.find(principal, { values, excludeId: id });
  }

  /** What merging `dto.duplicateId` into record `id` would do, checked as the merge checks it. */
  async preview(principal: Principal, id: string, dto: MergeDto) {
    return (await this.plan(principal, id, dto)).preview;
  }

  /**
   * Merges `dto.duplicateId` into record `id`, in one transaction: all of
   * it, or (any check or write refused) none of it. Answers the survivor.
   */
  @Transactional()
  async merge(principal: Principal, id: string, dto: MergeDto, ip?: string) {
    const { subject } = this.record;
    const { store, presenter } = this.registration;
    // Both rows locked, in id order (two merges of the same pair can't deadlock).
    await this.repository.lock(this.table, [id, dto.duplicateId]);
    const { survivor, duplicate, changes } = await this.plan(
      principal,
      id,
      dto,
    );
    const moved = await this.moveReferences(duplicate.id, survivor.id);
    // To the recycle bin first: a unique value it holds is free for the survivor.
    await store.delete(principal, duplicate.id, {
      check: (row) =>
        this.authorization.authorize(this.policy, 'delete', principal, row),
    });
    const merged =
      Object.keys(changes).length > 0
        ? await store.update(
            principal,
            survivor.id,
            recordValues(this.record, changes),
            {
              input: changes,
              check: (row) =>
                this.authorization.authorize(
                  this.policy,
                  'update',
                  principal,
                  row,
                ),
            },
          )
        : survivor;
    // The add-ons move what they keep about the duplicate (RecordHooks.merged).
    await store.merged(principal, duplicate, merged);
    const key = recordKey(this.record);
    await this.audit.record(principal, {
      action: `${key}.merged`,
      targetType: key,
      targetId: survivor.id,
      details: {
        duplicateId: duplicate.id,
        fields: Object.keys(changes),
        references: moved,
      },
      ip,
    });
    await this.events.publish(
      mergeEvents(this.record).merged,
      {
        subject,
        id: survivor.id,
        duplicateId: duplicate.id,
        by: principalKey(principal),
      },
      // Its own key: a merge is not ordered after the record's other events.
      { key: `merge:${duplicate.id}` },
    );
    return presenter.one(principal, merged);
  }

  /**
   * The checks, and what the merge would change: both records readable,
   * the survivor changeable and the duplicate deletable by the principal,
   * the duplicate under no legal hold, each chosen field one they may read
   * on both and change on the survivor, every record referring to the
   * duplicate (in the recycle bin too) one they may change, and no
   * reference of the survivor's to the duplicate left.
   */
  private async plan(principal: Principal, id: string, dto: MergeDto) {
    const { subject, noun, path } = this.record;
    if (id === dto.duplicateId) {
      throw new UnprocessableEntityException({
        code: 'merge_same_record',
        message: `A ${noun} can't be merged into itself.`,
      });
    }
    const { store, presenter } = this.registration;
    const survivor = await store.findOne(id, { visibleTo: principal });
    const duplicate = await store.findOne(dto.duplicateId, {
      visibleTo: principal,
    });
    if (
      !(await this.authorization.can(
        this.policy,
        'update',
        principal,
        survivor,
      )) ||
      !(await this.authorization.can(
        this.policy,
        'delete',
        principal,
        duplicate,
      ))
    ) {
      throw new ForbiddenException(
        `You may not merge these ${path.replace(/-/g, ' ')}: it takes changing the survivor and deleting the duplicate.`,
      );
    }
    await this.holds.assertNotHeld(subject, [duplicate.id]);

    const [shownSurvivor, shownDuplicate] = await presenter.many(principal, [
      survivor,
      duplicate,
    ]);
    const readable = Object.keys(writableFields(this.record.fields)).filter(
      (name) => name in shownSurvivor! && name in shownDuplicate!,
    );
    const unwritable = new Set(
      await this.access.forbiddenFields(
        principal,
        'update',
        subject,
        Object.fromEntries(readable.map((name) => [name, true])),
        survivor,
      ),
    );
    const choosable = readable.filter((name) => !unwritable.has(name));
    const refused = Object.keys(dto.fields).filter(
      (name) => dto.fields[name] === 'duplicate' && !choosable.includes(name),
    );
    if (refused.length) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `You may not choose: ${refused.join(', ')}.`,
        fields: refused,
      });
    }
    const duplicateView = recordView(this.record, duplicate) as Record<
      string,
      unknown
    >;
    const changes = Object.fromEntries(
      choosable
        .filter((name) => dto.fields[name] === 'duplicate')
        .map((name) => [name, duplicateView[name]]),
    );
    const survivorView = recordView(this.record, survivor) as Record<
      string,
      unknown
    >;
    for (const relation of relationsFrom(this.record)) {
      const value =
        relation.field in changes
          ? changes[relation.field]
          : survivorView[relation.field];
      if (relation.target() === subject && value === duplicate.id) {
        throw new UnprocessableEntityException({
          code: 'merge_self_reference',
          message: `${relation.field}: the survivor would refer to itself; choose another value first.`,
          field: relation.field,
        });
      }
    }
    const references = await this.references(principal, duplicate.id);
    const preview: MergePreview = {
      survivor: shownSurvivor!,
      duplicate: shownDuplicate!,
      fields: choosable.map((name) => ({
        name,
        survivor: shownSurvivor![name] ?? null,
        duplicate: shownDuplicate![name] ?? null,
        differs:
          JSON.stringify(shownSurvivor![name] ?? null) !==
          JSON.stringify(shownDuplicate![name] ?? null),
        keep: dto.fields[name] === 'duplicate' ? 'duplicate' : 'survivor',
      })),
      result: {
        ...shownSurvivor,
        ...Object.fromEntries(
          Object.keys(changes).map((name) => [name, shownDuplicate![name]]),
        ),
      },
      moves: { references },
    };
    return { survivor, duplicate, changes, references, preview };
  }

  /**
   * The relations whose records refer to the duplicate, with how many do:
   * refused (403) when any of them, live or in the recycle bin, is one the
   * principal may not change, or its reference field is. Those in the bin are repointed too, so a
   * restore brings them back pointing at the survivor.
   */
  private async references(principal: Principal, duplicateId: string) {
    const found: { subject: string; field: string; count: number }[] = [];
    for (const relation of relationsTo(this.record.subject)) {
      const soft = relation.from.softDelete;
      let total = 0;
      for (const deleted of soft ? [false, true] : [false]) {
        const referring = (
          filter?: Parameters<MergeRepository['countReferring']>[3],
        ) =>
          this.repository.countReferring(
            relation,
            duplicateId,
            soft ? deleted : undefined,
            filter,
          );
        const n = await referring();
        if (n === 0) continue;
        // The reference itself is a field: one the principal may not change,
        // on any of these records or only on some, refuses the merge as a
        // record they may not change does.
        const [denied, conditional] = await Promise.all([
          this.access.deniedFields(principal, 'update', relation.from.subject),
          this.access.conditionalFields(
            principal,
            'update',
            relation.from.subject,
          ),
        ]);
        const fieldForbidden =
          denied.includes(relation.field) ||
          conditional.includes(relation.field);
        const changeable = fieldForbidden
          ? 0
          : await referring(
              await this.access.sqlFilter(
                principal,
                relation.from.subject,
                'update',
                { deleted },
              ),
            );
        if (changeable < n) {
          throw new ForbiddenException({
            code: 'merge_references_forbidden',
            message: `Some ${relation.from.path.replace(/-/g, ' ')} refer to the duplicate (${relation.field}) that you may not change.`,
            subject: relation.from.subject,
            field: relation.field,
          });
        }
        total += n;
      }
      if (total > 0) {
        found.push({
          subject: relation.from.subject,
          field: relation.field,
          count: total,
        });
      }
    }
    return found;
  }

  /**
   * The references to the duplicate, repointed at the survivor: their ids, for the audit entry.
   * shortcut: one UPDATE per relation, not RecordStore.update() per record, so the referring
   * records' hooks, audit entries and `updated` events don't run (the merge's own audit entry
   * lists them); move them through the store if an add-on must hear of a changed reference.
   */
  private async moveReferences(from: string, to: string) {
    const moved: { subject: string; field: string; ids: string[] }[] = [];
    for (const relation of relationsTo(this.record.subject)) {
      const ids = await this.repository.moveReferences(relation, from, to);
      if (ids.length) {
        moved.push({
          subject: relation.from.subject,
          field: relation.field,
          ids,
        });
      }
    }
    return moved;
  }
}
