import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type { DatabaseTransactions } from '../../core/database/database.js';
import {
  fieldsRead,
  type List,
  type ListQuery,
} from '../../core/http/list-query.js';
import { pageQuerySchema, toPage } from '../../core/http/pagination.js';
import { AccessService } from '../../iam/access/access.service.js';
import { manager } from '../../iam/access/access.policy.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  principalKey,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import { OrganizationService } from '../../iam/organization/organization.service.js';
import { ListsService } from '../lists/lists.service.js';
import { Records } from '../records/records.service.js';
import type { CreateViewDto, UpdateViewDto } from './view.schemas.js';
import { type ViewSeer, ViewsRepository } from './views.repository.js';
import type { SavedViewRow, ViewVisibility } from './views.tables.js';

/** At most this many saved views per owner. */
export const MAX_VIEWS_PER_OWNER = 100;

/** What a view never holds: paging and the other parameters a list route takes besides its filters. */
const NOT_A_FILTER = new Set([
  ...Object.keys(pageQuerySchema.shape),
  'fields',
  'deleted',
  'lang',
  'include',
]);

const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/** What a name is unique within, with the subject. */
const scopeOf = (
  visibility: ViewVisibility,
  owner: string,
  unitId: string | null,
) =>
  visibility === 'private'
    ? owner
    : visibility === 'unit'
      ? `unit:${unitId}`
      : 'tenant';

/**
 * Saved views: a list's filters, sort and columns kept under a name,
 * private to their owner, shared with a unit, or tenant-wide. The list is
 * any a record or the access API describes (`ListsService`), so a view
 * works for every subject without the subject knowing. A view is
 * validated against the list as the list route validates a query, when
 * saved and again when applied, then checked against the viewer's
 * field-level permissions: a filter, sort or search on a field they may
 * not read is a 403 (it would tell its value); a column they may not see
 * is left out.
 */
@Injectable()
export class ViewsService {
  constructor(
    private readonly repository: ViewsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly lists: ListsService,
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly organization: OrganizationService,
  ) {}

  /** A page of the views the principal sees (theirs, their units', the tenant's) of the lists they may read. */
  async page(principal: RequestPrincipal, query: ListQuery) {
    const readable = await this.readableSubjects(principal);
    const seer = await this.seer(principal);
    const isManager = await this.isManager(principal);
    const [rows, total] = await this.repository.page(seer, readable, query);
    const page = toPage(rows, query, total);
    return {
      ...page,
      items: page.items.map((row) => this.view(principal, row, isManager)),
    };
  }

  async get(principal: RequestPrincipal, id: string) {
    return this.view(
      principal,
      await this.findVisible(principal, id),
      await this.isManager(principal),
    );
  }

  async create(principal: RequestPrincipal, dto: CreateViewDto, ip?: string) {
    await this.checkDefinition(
      principal,
      dto.subject,
      dto.query,
      dto.columns,
      'save',
    );
    const owner = principalKey(principal);
    const unitId = dto.unitId ?? null;
    await this.assertMayShare(principal, dto.visibility, unitId);
    const row = await this.txHost.withTransaction(async () => {
      await this.assertRoomFor(owner);
      const created = await this.repository
        .insert({
          subject: dto.subject,
          name: dto.name,
          visibility: dto.visibility,
          owner,
          unitId,
          scope: scopeOf(dto.visibility, owner, unitId),
          query: dto.query,
          columns: dto.columns,
        })
        .catch((error: unknown) => {
          throw this.taken(error, dto.subject, dto.name);
        });
      await this.audit.record(principal, {
        action: 'view.created',
        targetType: 'view',
        targetId: created.id,
        details: { subject: dto.subject, name: dto.name },
        ip,
      });
      return created;
    });
    return this.view(principal, row, await this.isManager(principal));
  }

  /** Only what is sent changes; its owner, or a view manager for a shared one. */
  async update(
    principal: RequestPrincipal,
    id: string,
    dto: UpdateViewDto,
    ip?: string,
  ) {
    const view = await this.findVisible(principal, id);
    const isManager = await this.isManager(principal);
    this.assertMayChange(principal, view, isManager);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateViewDto;
    if (Object.keys(values).length === 0) {
      return this.view(principal, view, isManager);
    }
    const visibility = values.visibility ?? view.visibility;
    const reshare =
      values.visibility !== undefined || values.unitId !== undefined;
    // A unit is named only for a unit view; leaving `unit` forgets it.
    const unitId =
      visibility === 'unit'
        ? values.unitId !== undefined
          ? values.unitId
          : view.unitId
        : null;
    if (visibility === 'unit' && !unitId) {
      throw invalid([
        { path: 'unitId', message: 'A unit view names its unit (unitId).' },
      ]);
    }
    if (visibility !== 'unit' && values.unitId) {
      throw invalid([
        { path: 'unitId', message: 'Only a unit view has a unit.' },
      ]);
    }
    if (reshare) {
      if (visibility === 'private' && view.owner !== principalKey(principal)) {
        throw new ForbiddenException({
          code: 'forbidden',
          message: "Only a view's owner makes it private.",
        });
      }
      if (visibility !== view.visibility || unitId !== view.unitId) {
        await this.assertMayShare(principal, visibility, unitId);
      }
    }
    if (values.query !== undefined || values.columns !== undefined) {
      await this.checkDefinition(
        principal,
        view.subject,
        values.query ?? view.query,
        values.columns === undefined ? view.columns : values.columns,
        'save',
      );
    }
    const row = await this.txHost.withTransaction(async () => {
      const updated = await this.repository
        .update(id, {
          ...(values.name !== undefined && { name: values.name }),
          ...(values.query !== undefined && { query: values.query }),
          ...(values.columns !== undefined && { columns: values.columns }),
          ...(reshare && {
            visibility,
            unitId,
            scope: scopeOf(visibility, view.owner, unitId),
          }),
        })
        .catch((error: unknown) => {
          throw this.taken(error, view.subject, values.name ?? view.name);
        });
      await this.audit.record(principal, {
        action: 'view.updated',
        targetType: 'view',
        targetId: id,
        details: { subject: view.subject, changed: Object.keys(values) },
        ip,
      });
      return updated;
    });
    return this.view(principal, row, isManager);
  }

  async remove(principal: RequestPrincipal, id: string, ip?: string) {
    const view = await this.findVisible(principal, id);
    this.assertMayChange(principal, view, await this.isManager(principal));
    await this.txHost.withTransaction(async () => {
      await this.repository.delete(id);
      await this.audit.record(principal, {
        action: 'view.deleted',
        targetType: 'view',
        targetId: id,
        details: { subject: view.subject, name: view.name },
        ip,
      });
    });
  }

  /**
   * The view as the viewer may use it, validated again against the list as
   * it is now (a custom field removed since makes a 400 naming the
   * parameter), their field permissions applied (a 403 `field_forbidden`
   * for a filter, sort or search on a field they may not read), and its
   * columns less those they may not see. `params` is the list route's query.
   */
  async apply(principal: RequestPrincipal, id: string) {
    const view = await this.findVisible(principal, id);
    const { hidden } = await this.checkDefinition(
      principal,
      view.subject,
      view.query,
      view.columns,
      'apply',
    );
    const columns = view.columns?.filter((column) => !hidden(column)) ?? null;
    const hiddenColumns = view.columns?.filter(hidden) ?? [];
    return {
      view: this.view(
        principal,
        { ...view, columns },
        await this.isManager(principal),
      ),
      params: {
        ...view.query,
        ...(columns?.length && { fields: columns.join(',') }),
      },
      columns,
      hiddenColumns,
    };
  }

  /** The list of a subject, or a 400 naming the subjects that have one. */
  private listOf(subject: string): List {
    try {
      return this.lists.source(subject).list;
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      throw invalid([
        {
          path: 'subject',
          message: `"${subject}" has no list: one of ${this.subjects().join(', ')}`,
        },
      ]);
    }
  }

  /** The subjects that have a list (GET /v1/lists/{subject}). */
  private subjects() {
    return [...this.records.all().map((r) => r.declaration.subject), 'User'];
  }

  /**
   * The query and columns checked as the list route checks a request, as
   * 400s on `query.<parameter>` and `columns`: only the list's own filters
   * (no paging, `fields`, `deleted`, `lang`), every column one of its
   * `select`. Then the viewer's field permissions: a 403 `field_forbidden`
   * for a filter, sort or search on a field they may not read.
   */
  private async checkDefinition(
    principal: RequestPrincipal,
    subject: string,
    raw: Record<string, string>,
    columns: string[] | null,
    when: 'save' | 'apply',
  ) {
    const list = this.listOf(subject);
    if (!(await this.lists.mayRead(principal, subject))) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: `You may not read ${subject}.`,
      });
    }
    const errors: { path: string; message: string }[] = [];
    const filters = Object.fromEntries(
      Object.entries(raw).filter(([key]) => {
        if (NOT_A_FILTER.has(key)) {
          errors.push({
            path: `query.${key}`,
            message: `A view holds filters, sort and search, not "${key}" (its columns are \`columns\`).`,
          });
          return false;
        }
        return true;
      }),
    );
    const parsed = list.schema.safeParse(filters);
    if (!parsed.success) {
      const stale =
        when === 'apply' ? ' (the list changed since the view was saved)' : '';
      for (const issue of parsed.error.issues) {
        // A parameter the list doesn't know is named by its key, not the root.
        const unknown =
          issue.code === 'unrecognized_keys' ? issue.keys : undefined;
        for (const path of unknown?.map((key) => [key]) ?? [issue.path]) {
          errors.push({
            path: ['query', ...path].join('.'),
            message: issue.message + stale,
          });
        }
      }
    }
    const select = list.options.select ?? [];
    for (const column of columns ?? []) {
      if (!select.includes(column)) {
        errors.push({
          path: 'columns',
          message: `Not a field of this list: ${column}`,
        });
      }
    }
    if (errors.length) throw invalid(errors);
    if (parsed.success) {
      await this.access.assertQueryFields(
        principal,
        subject,
        parsed.data as ListQuery,
      );
    }
    const denied = new Set(
      await this.access.deniedFields(principal, 'read', subject),
    );
    return {
      /** A column the viewer may not read: left out. */
      hidden: (column: string) =>
        fieldsRead(list.fields, column).some((field) => denied.has(field)),
    };
  }

  /** A view manager: users only, not while impersonating (as every Access permission). */
  private async isManager(principal: RequestPrincipal) {
    return (
      manager(principal) &&
      (await this.access.can(principal, 'manageViews', 'Access'))
    );
  }

  /** Who may share with a unit (a current member of it, or a manager) or the tenant (a manager). */
  private async assertMayShare(
    principal: RequestPrincipal,
    visibility: ViewVisibility,
    unitId: string | null,
  ) {
    if (visibility === 'private') return;
    const isManager = await this.isManager(principal);
    if (visibility === 'tenant') {
      if (!isManager) {
        throw new ForbiddenException({
          code: 'forbidden',
          message: 'Sharing a view with everyone takes Access.manageViews.',
        });
      }
      return;
    }
    const unit = await this.repository.findUnitId(unitId!);
    if (!unit) {
      throw invalid([{ path: 'unitId', message: 'No such unit.' }]);
    }
    if (
      !isManager &&
      !(
        principal.kind === 'user' &&
        (await this.organization.unitsOf(principal.id)).includes(unit)
      )
    ) {
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          'Sharing a view with a unit takes belonging to it, or Access.manageViews.',
      });
    }
  }

  /** Its owner changes a view; a shared one, a view manager too. */
  private assertMayChange(
    principal: RequestPrincipal,
    view: SavedViewRow,
    isManager: boolean,
  ) {
    if (!this.mayChange(principal, view, isManager)) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only a view's owner changes it.",
      });
    }
  }

  private mayChange(
    principal: RequestPrincipal,
    view: SavedViewRow,
    isManager: boolean,
  ) {
    return (
      view.owner === principalKey(principal) ||
      (isManager && view.visibility !== 'private')
    );
  }

  private view(
    principal: RequestPrincipal,
    row: SavedViewRow,
    isManager: boolean,
  ) {
    return {
      id: row.id,
      subject: row.subject,
      name: row.name,
      visibility: row.visibility,
      unitId: row.unitId,
      owner: row.owner,
      mine: row.owner === principalKey(principal),
      editable: this.mayChange(principal, row, isManager),
      query: row.query,
      columns: row.columns,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Who the principal is to views: they see theirs, their units', the tenant's. */
  private async seer(principal: RequestPrincipal): Promise<ViewSeer> {
    return {
      owner: principalKey(principal),
      unitIds:
        principal.kind === 'user'
          ? await this.organization.unitsOf(principal.id)
          : [],
    };
  }

  /** The lists the principal may read (a view of another is not theirs to see). */
  private async readableSubjects(principal: RequestPrincipal) {
    const subjects = this.subjects();
    const may = await Promise.all(
      subjects.map((subject) => this.lists.mayRead(principal, subject)),
    );
    return subjects.filter((_, index) => may[index]);
  }

  /** A view the principal sees (and whose list they may read), else a 404 as for one that doesn't exist. */
  private async findVisible(principal: RequestPrincipal, id: string) {
    const row = await this.repository.findVisible(
      await this.seer(principal),
      id,
    );
    if (
      !row ||
      !this.subjects().includes(row.subject) ||
      !(await this.lists.mayRead(principal, row.subject))
    ) {
      throw new NotFoundException(`View ${id} not found.`);
    }
    return row;
  }

  /** A unique violation is a 409 naming the name; anything else passes. */
  private taken(error: unknown, subject: string, name: string) {
    return databaseErrorKind(error) === 'unique_violation'
      ? new ConflictException({
          code: 'conflict',
          message: `A view named "${name}" of ${subject} exists where you save it.`,
        })
      : error;
  }

  /**
   * A 400 when the owner has MAX_VIEWS_PER_OWNER views already. Two saves
   * racing may pass the limit by one: it is a courtesy, not a quota.
   */
  private async assertRoomFor(owner: string) {
    if ((await this.repository.countOwnedBy(owner)) >= MAX_VIEWS_PER_OWNER) {
      throw invalid([
        {
          path: 'name',
          message: `At most ${MAX_VIEWS_PER_OWNER} views: delete one first.`,
        },
      ]);
    }
  }
}
