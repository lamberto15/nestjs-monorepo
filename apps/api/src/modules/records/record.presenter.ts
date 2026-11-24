import { Inject, Injectable, type PipeTransform } from '@nestjs/common';
import { AuthorizationService } from '@nestjs/authorization';
import { z } from 'zod';
import { untagged } from '../../core/http/etag.js';
import type { List, ListQuery } from '../../core/http/list-query.js';
import { validationException } from '../../core/http/problem-details.filter.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { type RecordDeclaration, recordView } from './record.js';
import { RECORD } from './record-extension.js';
import { includeNameOf, relationsFrom } from './record-relations.js';
import { RecordFeature, Records } from './records.service.js';
import { RecordTitles } from './record-titles.js';

/** What a request asked to include (`?include=can,watching`): the names. */
export type RecordInclude = readonly string[];

const includeSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) =>
    [value ?? []]
      .flat()
      .flatMap((part) => part.split(','))
      .map((part) => part.trim())
      .filter(Boolean),
  );

/**
 * `@Query('include', IncludePipe)`: `?include=can` (and what the record's
 * add-ons answer, `watching`) as the names; any other is a 400, before the
 * route loads anything.
 */
@Injectable()
export class IncludePipe implements PipeTransform<unknown, RecordInclude> {
  constructor(
    @Inject(RECORD) private readonly record: RecordDeclaration,
    private readonly records: Records,
  ) {}

  transform(value: unknown): RecordInclude {
    const names = includeSchema.parse(value);
    const known = [
      'can',
      ...relationsFrom(this.record).map((relation) =>
        includeNameOf(relation.field),
      ),
      ...this.records
        .of(this.record.subject)
        .extensions.flatMap((hooks) =>
          hooks.include ? [hooks.include.name] : [],
        ),
    ];
    const unknown = names.filter((name) => !known.includes(name));
    if (unknown.length > 0) {
      throw validationException([
        {
          path: ['include'],
          message: `${this.record.subject} records include ${known.join(', ')}, not ${unknown.join(', ')}.`,
        },
      ]);
    }
    return [...new Set(names)];
  }
}

/** The `include` query parameter, for a record route's OpenAPI (`@ApiQuery(includeQuery())`). */
export const includeQuery = () => ({
  name: 'include',
  required: false,
  type: String,
  description:
    '`can`: each record says what you may do with it now (`can.update`, `can.delete`, `can.restore`), as its routes would decide. A reference field without its `Id` (`parent`) adds `{ id, title }` of the record it names, null when you may not read it. Add-ons answer more (`watching`); another value is a 400. Comma-separated. Not part of the ETag.',
  example: 'can',
});

/**
 * Records as a caller reads them: the API's view (money as objects, no
 * tenant), what the record's add-ons show (`present()`), less the fields
 * the caller may not see (field-level permissions), and with `?include=`
 * what they asked for (`can`, the add-ons' includes), left out of the
 * ETag. The list query too: validated against the list with its add-ons'
 * filters, refused on a field the caller may not use. Provided by
 * RecordsModule.forFeature().
 */
@Injectable()
export class RecordPresenter {
  constructor(
    private readonly feature: RecordFeature,
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly authorization: AuthorizationService,
    private readonly titles: RecordTitles,
  ) {}

  private get declaration() {
    return this.feature.declaration;
  }

  private get registration() {
    return this.records.of(this.declaration.subject);
  }

  /**
   * A list request's query: validated against the list (a 400 naming what
   * is wrong), then refused (403 `field_forbidden`) when it uses a field
   * the caller may not (AccessService.assertQueryFields). Answers the list
   * it was checked against: pass both to `findPage()` and `page()`.
   */
  async query(
    user: Principal,
    raw: Record<string, unknown>,
  ): Promise<{ list: List; query: ListQuery }> {
    const list = await this.registration.listFor(user);
    // `include` is no filter: the route reads it (IncludePipe).
    const { include: _include, ...filters } = raw;
    const query = list.parse(filters);
    await this.access.assertQueryFields(user, this.declaration.subject, query, {
      reach: query.deleted ? 'restore' : 'read',
    });
    return { list, query };
  }

  /** Records, as the caller may see them (each add-on's part read once for them all). */
  async many(user: Principal, rows: Record<string, unknown>[]) {
    let views = rows.map(
      (row) => recordView(this.declaration, row) as Record<string, unknown>,
    );
    for (const hooks of this.registration.extensions) {
      if (hooks.present) views = await hooks.present(user, views);
    }
    return this.access.redactAll(user, 'read', this.declaration.subject, views);
  }

  /** One record, as the caller may see it, with what `include` asks for. */
  async one(
    user: Principal,
    row: Record<string, unknown>,
    include: RecordInclude = [],
  ) {
    const [shown] = await this.many(user, [row]);
    if (include.length === 0) return shown!;
    const included = await this.included(user, [row], [shown!], include);
    return withIncluded(shown!, included);
  }

  /** A page as the caller may see it: then only `?fields=` (after redaction), then `include`. */
  async page<P extends { items: Record<string, unknown>[] }>(
    user: Principal,
    page: P,
    {
      list,
      query,
      include = [],
    }: { list: List; query: ListQuery; include?: RecordInclude },
  ) {
    const shown = await this.many(user, page.items);
    const picked = list.pick({ ...page, items: shown }, query);
    if (include.length === 0) return picked;
    const included = await this.included(user, page.items, shown, include);
    return {
      ...picked,
      items: picked.items.map((item) =>
        withIncluded(item as Record<string, unknown>, included),
      ),
    };
  }

  /**
   * What `include` asked for, by name, then by record id. `shown` are the
   * rows as the caller may see them (many()): a reference is followed only
   * where its field is shown.
   */
  private async included(
    user: Principal,
    rows: Record<string, unknown>[],
    shown: Record<string, unknown>[],
    include: RecordInclude,
  ) {
    const ids = rows.map((row) => row.id as string);
    const found = new Map<string, Map<string, unknown>>();
    if (include.includes('can')) {
      found.set('can', await this.can(user, rows));
    }
    for (const relation of relationsFrom(this.declaration)) {
      const name = includeNameOf(relation.field);
      if (include.includes(name)) {
        found.set(name, await this.referenced(user, shown, relation));
      }
    }
    for (const hooks of this.registration.extensions) {
      if (hooks.include && include.includes(hooks.include.name)) {
        found.set(hooks.include.name, await hooks.include.values(user, ids));
      }
    }
    return found;
  }

  /**
   * The records a page's rows refer to through `relation` (`?include=parent`),
   * by row id: `{ id, title }` of one the caller may read, else null. Read
   * from the rows as shown, so a reference whose field is hidden on a row
   * (a field the caller reads on some records only) stays hidden: null.
   */
  private async referenced(
    user: Principal,
    rows: Record<string, unknown>[],
    relation: ReturnType<typeof relationsFrom>[number],
  ) {
    const subject = relation.target();
    const ids = [
      ...new Set(
        rows.flatMap((row) => {
          const id = row[relation.field];
          return typeof id === 'string' ? [id] : [];
        }),
      ),
    ];
    const found = new Map<string, { id: string; title: string | null }>();
    if (subject && ids.length > 0) {
      // The titles pickers show (RecordTitles), of the live ones the caller may read.
      const titles = await this.titles.of(user, subject, ids);
      for (const [id, title] of titles) found.set(id, { id, title });
    }
    return new Map<string, unknown>(
      rows.map((row) => [
        row.id as string,
        found.get(row[relation.field] as string) ?? null,
      ]),
    );
  }

  /**
   * Each row's `can`: the policy check of the route that does each action,
   * in memory. `restore` only for a row in the recycle bin.
   */
  private async can(user: Principal, rows: Record<string, unknown>[]) {
    const { policy } = this.feature;
    const actions = this.declaration.softDelete
      ? ['update', 'delete', 'restore']
      : ['update', 'delete'];
    // The ability is a string here, not one of a known policy's literals.
    const can = this.authorization.can.bind(this.authorization) as (
      policy: unknown,
      ability: string,
      user: Principal,
      row: unknown,
    ) => Promise<boolean>;
    return new Map<string, unknown>(
      await Promise.all(
        rows.map(
          async (row) =>
            [
              row.id as string,
              Object.fromEntries(
                await Promise.all(
                  actions.map(async (action) => [
                    action,
                    action === 'restore' && row.deletedAt == null
                      ? false
                      : await can(policy, action, user, row),
                  ]),
                ),
              ),
            ] as const,
        ),
      ),
    );
  }
}

/** The shown record with what `include` found for it, left out of its ETag (`untagged()`). */
function withIncluded(
  shown: Record<string, unknown>,
  included: Map<string, Map<string, unknown>>,
) {
  const id = shown.id as string;
  const extra = Object.fromEntries(
    [...included].map(([name, values]) => [name, values.get(id) ?? null]),
  );
  return untagged({ ...shown, ...extra }, Object.keys(extra));
}
