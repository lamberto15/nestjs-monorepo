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
import type { ListQuery } from '../../core/http/list-query.js';
import { toPage } from '../../core/http/pagination.js';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  principalKey,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import { OrganizationService } from '../../iam/organization/organization.service.js';
import { fieldSchemas } from '../fields/fields.js';
import { Records } from '../records/records.service.js';
import type {
  CreateTemplateDto,
  UpdateTemplateDto,
} from './template.schemas.js';
import {
  type TemplateSeer,
  TemplatesRepository,
} from './templates.repository.js';
import type {
  RecordTemplateRow,
  TemplateVisibility,
} from './templates.tables.js';

/** At most this many templates per owner. */
export const MAX_TEMPLATES_PER_OWNER = 100;

/** The record's capability name: a record that imports `TemplatesModule.forRecord()` takes templates. */
export const TEMPLATES_CAPABILITY = 'templates';

/** Set by the system when a record is created (its number's series): never a template's value. */
const SYSTEM_FIELDS = new Set(['namingSeriesId']);

/** A value a template holds that the create route would not take as it is now. */
export interface DroppedValue {
  field: string;
  reason: 'unknown' | 'invalid' | 'forbidden';
  message: string;
}

const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/** What a name is unique within, with the subject. */
const scopeOf = (
  visibility: TemplateVisibility,
  owner: string,
  unitId: string | null,
) =>
  visibility === 'private'
    ? owner
    : visibility === 'unit'
      ? `unit:${unitId}`
      : 'tenant';

/**
 * Record templates: values to prefill a new record, kept under a name,
 * private to their owner, shared with a unit, or tenant-wide. A template
 * never creates anything and never bypasses a check: it is validated
 * against the subject's create schema and the saver's field permissions
 * when saved, and again when previewed for whoever uses it (a value the
 * schema or their permissions no longer allow is dropped and reported); the
 * client then creates the record through the subject's own route.
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly repository: TemplatesRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly organization: OrganizationService,
  ) {}

  /** The records that opted in (`TemplatesModule.forRecord()`), by subject. */
  private templated() {
    return this.records
      .all()
      .filter((record) =>
        record.extensions.some(
          (hooks) => hooks.capability === TEMPLATES_CAPABILITY,
        ),
      );
  }

  /** The subject's create body shape, or a 400 naming the subjects that take templates. */
  private shapeOf(subject: string) {
    const record = this.templated().find(
      (found) => found.declaration.subject === subject,
    );
    if (!record) {
      throw invalid([
        {
          path: 'subject',
          message: `"${subject}" takes no templates: one of ${this.templated()
            .map((found) => found.declaration.subject)
            .join(', ')}`,
        },
      ]);
    }
    return fieldSchemas(record.declaration.fields).create.shape;
  }

  /** The subjects that take templates and the principal may create, with the fields they may set. */
  async subjects(principal: RequestPrincipal) {
    const items = await Promise.all(
      this.templated().map(async ({ declaration }) => {
        const { subject } = declaration;
        if (!(await this.access.can(principal, 'create', subject))) {
          return null;
        }
        const denied = new Set(
          await this.access.deniedFields(principal, 'create', subject),
        );
        const fields = Object.keys(this.shapeOf(subject))
          .filter((field) => !SYSTEM_FIELDS.has(field) && !denied.has(field))
          .sort((a, b) => a.localeCompare(b));
        return { subject, fields };
      }),
    );
    return { items: items.filter((item) => item !== null) };
  }

  /** A page of the templates the principal sees (theirs, their units', the tenant's) of the records they may create. */
  async page(principal: RequestPrincipal, query: ListQuery) {
    const creatable = (await this.subjects(principal)).items.map(
      (item) => item.subject,
    );
    const seer = await this.seer(principal);
    const isManager = await this.isManager(principal);
    const [rows, total] = await this.repository.page(seer, creatable, query);
    const page = toPage(rows, query, total);
    return {
      ...page,
      items: page.items.map((row) => this.template(principal, row, isManager)),
    };
  }

  async get(principal: RequestPrincipal, id: string) {
    return this.template(
      principal,
      await this.findVisible(principal, id),
      await this.isManager(principal),
    );
  }

  async create(
    principal: RequestPrincipal,
    dto: CreateTemplateDto,
    ip?: string,
  ) {
    await this.assertSaveable(principal, dto.subject, dto.values);
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
          values: dto.values,
        })
        .catch((error: unknown) => {
          throw this.taken(error, dto.subject, dto.name);
        });
      await this.audit.record(principal, {
        action: 'recordTemplate.created',
        targetType: 'recordTemplate',
        targetId: created.id,
        details: { subject: dto.subject, name: dto.name },
        ip,
      });
      return created;
    });
    return this.template(principal, row, await this.isManager(principal));
  }

  /** Only what is sent changes; its owner, or a template manager for a shared one. */
  async update(
    principal: RequestPrincipal,
    id: string,
    dto: UpdateTemplateDto,
    ip?: string,
  ) {
    const found = await this.findVisible(principal, id);
    const isManager = await this.isManager(principal);
    this.assertMayChange(principal, found, isManager);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateTemplateDto;
    if (Object.keys(values).length === 0) {
      return this.template(principal, found, isManager);
    }
    const visibility = values.visibility ?? found.visibility;
    const reshare =
      values.visibility !== undefined || values.unitId !== undefined;
    // A unit is named only for a unit template; leaving `unit` forgets it.
    const unitId =
      visibility === 'unit'
        ? values.unitId !== undefined
          ? values.unitId
          : found.unitId
        : null;
    if (visibility === 'unit' && !unitId) {
      throw invalid([
        {
          path: 'unitId',
          message: 'A unit template names its unit (unitId).',
        },
      ]);
    }
    if (visibility !== 'unit' && values.unitId) {
      throw invalid([
        { path: 'unitId', message: 'Only a unit template has a unit.' },
      ]);
    }
    if (reshare) {
      if (visibility === 'private' && found.owner !== principalKey(principal)) {
        throw new ForbiddenException({
          code: 'forbidden',
          message: "Only a template's owner makes it private.",
        });
      }
      if (visibility !== found.visibility || unitId !== found.unitId) {
        await this.assertMayShare(principal, visibility, unitId);
      }
    }
    if (values.values !== undefined) {
      await this.assertSaveable(principal, found.subject, values.values);
    }
    const row = await this.txHost.withTransaction(async () => {
      const updated = await this.repository
        .update(id, {
          ...(values.name !== undefined && { name: values.name }),
          ...(values.values !== undefined && { values: values.values }),
          ...(reshare && {
            visibility,
            unitId,
            scope: scopeOf(visibility, found.owner, unitId),
          }),
        })
        .catch((error: unknown) => {
          throw this.taken(error, found.subject, values.name ?? found.name);
        });
      await this.audit.record(principal, {
        action: 'recordTemplate.updated',
        targetType: 'recordTemplate',
        targetId: id,
        details: { subject: found.subject, changed: Object.keys(values) },
        ip,
      });
      return updated;
    });
    return this.template(principal, row, isManager);
  }

  async remove(principal: RequestPrincipal, id: string, ip?: string) {
    const found = await this.findVisible(principal, id);
    this.assertMayChange(principal, found, await this.isManager(principal));
    await this.txHost.withTransaction(async () => {
      await this.repository.delete(id);
      await this.audit.record(principal, {
        action: 'recordTemplate.deleted',
        targetType: 'recordTemplate',
        targetId: id,
        details: { subject: found.subject, name: found.name },
        ip,
      });
    });
  }

  /**
   * The template as the caller may use it now: every value checked again
   * against the subject's create schema as it is and the caller's own field
   * permissions. A value that fails is left out and named in `dropped`
   * (the template is stale: change it); the caller needs the permission to
   * create the subject. The result is only a body to prefill a form with:
   * the create route validates and authorizes it all again.
   */
  async preview(principal: RequestPrincipal, id: string) {
    const found = await this.findVisible(principal, id);
    await this.assertMayCreate(principal, found.subject);
    const { values, dropped } = await this.inspect(
      principal,
      found.subject,
      found.values,
    );
    return {
      template: this.template(
        principal,
        found,
        await this.isManager(principal),
      ),
      values,
      dropped,
    };
  }

  /**
   * Each value of a template against the subject's create schema (a value
   * at a time: the schema's required fields may be missing from a
   * template) and the principal's permission to set that field.
   */
  private async inspect(
    principal: RequestPrincipal,
    subject: string,
    input: Record<string, unknown>,
  ) {
    const shape = this.shapeOf(subject);
    const values: Record<string, unknown> = {};
    const dropped: DroppedValue[] = [];
    const forbidden = new Set(
      await this.access.forbiddenFields(principal, 'create', subject, input),
    );
    for (const [field, value] of Object.entries(input)) {
      const drop = (reason: DroppedValue['reason'], message: string) =>
        void dropped.push({ field, reason, message });
      if (!Object.hasOwn(shape, field) || SYSTEM_FIELDS.has(field)) {
        drop('unknown', 'Not a field a create takes.');
      } else if (forbidden.has(field)) {
        drop('forbidden', `You may not set ${field}.`);
      } else {
        const parsed = (
          shape as Record<string, { safeParse(value: unknown): any }>
        )[field]!.safeParse(value);
        if (parsed.success) values[field] = value;
        else drop('invalid', parsed.error?.issues[0]?.message ?? 'Invalid.');
      }
    }
    return { values, dropped };
  }

  /** A 403 unless the principal may create the subject's records: a template is only worth what a create is. */
  private async assertMayCreate(principal: RequestPrincipal, subject: string) {
    if (!(await this.access.can(principal, 'create', subject))) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: `You may not create ${subject}.`,
      });
    }
  }

  /**
   * What a template may hold when saved: the subject takes templates, the
   * saver may create it, and every value passes `inspect()` (a 400 naming
   * `values.<field>`, a 403 `field_forbidden` for fields they may not set).
   */
  private async assertSaveable(
    principal: RequestPrincipal,
    subject: string,
    input: Record<string, unknown>,
  ) {
    // A subject without templates is a bad request, before who may create it.
    this.shapeOf(subject);
    await this.assertMayCreate(principal, subject);
    const { dropped } = await this.inspect(principal, subject, input);
    const refused = dropped.filter((item) => item.reason !== 'forbidden');
    if (refused.length) {
      throw invalid(
        refused.map((item) => ({
          path: `values.${item.field}`,
          message: item.message,
        })),
      );
    }
    if (dropped.length) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `You may not set: ${dropped.map((item) => item.field).join(', ')}.`,
        fields: dropped.map((item) => item.field),
      });
    }
  }

  /** A template manager: users only, not while impersonating (as every Access permission). */
  private async isManager(principal: RequestPrincipal) {
    return (
      manager(principal) &&
      (await this.access.can(principal, 'manageTemplates', 'Access'))
    );
  }

  /** Who may share with a unit (a current member of it, or a manager) or the tenant (a manager). */
  private async assertMayShare(
    principal: RequestPrincipal,
    visibility: TemplateVisibility,
    unitId: string | null,
  ) {
    if (visibility === 'private') return;
    const isManager = await this.isManager(principal);
    if (visibility === 'tenant') {
      if (!isManager) {
        throw new ForbiddenException({
          code: 'forbidden',
          message:
            'Sharing a template with everyone takes Access.manageTemplates.',
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
          'Sharing a template with a unit takes belonging to it, or Access.manageTemplates.',
      });
    }
  }

  /** Its owner changes a template; a shared one, a template manager too. */
  private assertMayChange(
    principal: RequestPrincipal,
    found: RecordTemplateRow,
    isManager: boolean,
  ) {
    if (!this.mayChange(principal, found, isManager)) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only a template's owner changes it.",
      });
    }
  }

  private mayChange(
    principal: RequestPrincipal,
    found: RecordTemplateRow,
    isManager: boolean,
  ) {
    return (
      found.owner === principalKey(principal) ||
      (isManager && found.visibility !== 'private')
    );
  }

  private template(
    principal: RequestPrincipal,
    row: RecordTemplateRow,
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
      values: row.values,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Who the principal is to templates: they see theirs, their units', the tenant's. */
  private async seer(principal: RequestPrincipal): Promise<TemplateSeer> {
    return {
      owner: principalKey(principal),
      unitIds:
        principal.kind === 'user'
          ? await this.organization.unitsOf(principal.id)
          : [],
    };
  }

  /** A template the principal sees, else a 404 as for one that doesn't exist. */
  private async findVisible(principal: RequestPrincipal, id: string) {
    const row = await this.repository.findVisible(
      await this.seer(principal),
      id,
    );
    if (!row) throw new NotFoundException(`Template ${id} not found.`);
    return row;
  }

  /** A unique violation is a 409 naming the name; anything else passes. */
  private taken(error: unknown, subject: string, name: string) {
    return databaseErrorKind(error) === 'unique_violation'
      ? new ConflictException({
          code: 'conflict',
          message: `A template named "${name}" of ${subject} exists where you save it.`,
        })
      : error;
  }

  /**
   * A 400 when the owner has MAX_TEMPLATES_PER_OWNER templates already. Two
   * saves racing may pass the limit by one: it is a courtesy, not a quota.
   */
  private async assertRoomFor(owner: string) {
    if (
      (await this.repository.countOwnedBy(owner)) >= MAX_TEMPLATES_PER_OWNER
    ) {
      throw invalid([
        {
          path: 'name',
          message: `At most ${MAX_TEMPLATES_PER_OWNER} templates: delete one first.`,
        },
      ]);
    }
  }
}
