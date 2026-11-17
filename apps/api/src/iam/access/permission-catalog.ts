import {
  Injectable,
  Logger,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { I18nService } from '@nestjs/i18n';
import { getColumns, getColumnTable } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Principal } from '../auth/principal.js';
import {
  type AccessContext,
  type Condition,
  type ConditionValue,
  isAll,
  type PermissionInput,
  type PermissionsDefinition,
  type SeedRole,
  type SubjectDefinition,
  type SystemJobDefinition,
} from './permissions.js';

/** Ids of registered definitions: what Nest hashes for each forFeature() module. */
const ids = new WeakMap<object, number>();
let lastId = 0;

/**
 * One module's declaration, as `AccessModule.forFeature()` provides it in
 * that module; the catalog discovers every one. Serialized as a number:
 * Nest hashes a dynamic module's providers, and a declaration holds tables.
 */
export class PermissionsRegistration {
  constructor(readonly definition: PermissionsDefinition) {
    if (!ids.has(definition)) ids.set(definition, ++lastId);
  }

  toJSON() {
    return `permissions#${ids.get(this.definition)}`;
  }
}

/** A subject once every declaration of it is merged. */
export interface DeclaredSubject {
  actions: Record<string, readonly string[]>;
  conditions: Record<string, Condition<any>>;
  fields: Record<string, { sensitive?: boolean }>;
  deletedAt?: AnyPgColumn;
}

/** One comparison of a permission's conditions: the record field, its column, the values it may hold. */
export interface FieldComparison {
  field: string;
  column: AnyPgColumn;
  /** The values the field may hold; empty: none. */
  values: readonly (string | number | boolean)[];
}

/** A system job's key: lowercase words joined by `-`, groups by `.`. */
const JOB_KEY =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/;

/** The property a column has in its table: what a record (a Drizzle row) calls it. */
const fieldNames = new WeakMap<AnyPgColumn, string>();
export function fieldOf(column: AnyPgColumn): string {
  const known = fieldNames.get(column);
  if (known) return known;
  const entry = Object.entries(getColumns(getColumnTable(column))).find(
    ([, candidate]) => candidate === column,
  );
  if (!entry) {
    throw new Error(`Column ${column.name} is not a column of its table.`);
  }
  fieldNames.set(column, entry[0]);
  return entry[0];
}

const valuesOf = (
  value: ConditionValue,
): readonly (string | number | boolean)[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value as string];

/**
 * Every permission that exists: what the modules registered with
 * `AccessModule.forFeature()`. It validates what the access API receives,
 * turns stored conditions into comparisons (AccessService makes them CASL
 * and SQL), and names everything in the request's language: texts are in
 * the modules' catalogs under `permissions.` (README.md).
 */
@Injectable()
export class PermissionCatalog implements OnModuleInit {
  readonly subjects: Record<string, DeclaredSubject> = {};
  readonly clientPermissions: PermissionInput[] = [];
  readonly seedRoles: SeedRole[] = [];
  readonly systemJobs = new Map<string, SystemJobDefinition>();
  private readonly logger = new Logger('Access');

  constructor(
    @Optional() private readonly discovery?: DiscoveryService,
    // Absent where no I18nModule is imported: texts are their keys.
    @Optional() private readonly i18n?: I18nService,
  ) {}

  /** A catalog of these declarations alone (unit tests). */
  static of(...definitions: PermissionsDefinition[]) {
    const catalog = new PermissionCatalog();
    catalog.load(definitions);
    return catalog;
  }

  onModuleInit() {
    const found = new Set<PermissionsDefinition>();
    for (const wrapper of this.discovery?.getProviders() ?? []) {
      if (wrapper.instance instanceof PermissionsRegistration) {
        found.add(wrapper.instance.definition);
      }
    }
    this.load([...found]);
  }

  /** Merges the declarations, and refuses at startup anything inconsistent. */
  private load(definitions: PermissionsDefinition[]) {
    for (const definition of definitions) {
      for (const [name, declared] of Object.entries(
        definition.subjects ?? {},
      )) {
        this.mergeSubject(name, declared);
      }
    }
    for (const [name, subject] of Object.entries(this.subjects)) {
      for (const [action, keys] of Object.entries(subject.actions)) {
        const unknown = keys.filter((key) => !subject.conditions[key]);
        if (unknown.length) {
          throw new Error(
            `${name}.${action} names undeclared conditions: ${unknown.join(', ')}.`,
          );
        }
      }
    }
    const declared = (permission: PermissionInput, where: string) => {
      const result = this.validate(permission);
      if (!result.ok) {
        throw new Error(`${where}: ${result.error}`);
      }
      return result.value;
    };
    for (const definition of definitions) {
      for (const permission of definition.clientPermissions ?? []) {
        this.clientPermissions.push(
          declared(permission, 'A client permission'),
        );
      }
      for (const role of definition.seedRoles ?? []) {
        const permissions = role.permissions.map((permission) =>
          declared(permission, `Seed role ${role.key}`),
        );
        const seen = this.seedRoles.find((other) => other.key === role.key);
        if (seen) {
          seen.permissions.push(...permissions);
        } else {
          this.seedRoles.push({ key: role.key, permissions });
        }
      }
      for (const job of definition.systemJobs ?? []) {
        if (!JOB_KEY.test(job.key)) {
          throw new Error(
            `System job "${job.key}": a key is lowercase words joined by "-" (and "." between groups).`,
          );
        }
        if (this.systemJobs.has(job.key)) {
          throw new Error(`System job ${job.key} is declared twice.`);
        }
        const permissions = job.permissions.map((permission) => {
          // Nothing implicit: a job says what it does, never "everything".
          if (isAll(permission)) {
            throw new Error(
              `System job ${job.key} declares all.manage: declare what it does instead.`,
            );
          }
          return declared(permission, `System job ${job.key}`);
        });
        this.systemJobs.set(job.key, { key: job.key, permissions });
      }
    }
  }

  private mergeSubject(name: string, declared: SubjectDefinition) {
    if (name === 'all') {
      throw new Error(
        '"all" is CASL\'s word for every subject: name it otherwise.',
      );
    }
    const subject = (this.subjects[name] ??= {
      actions: {},
      conditions: {},
      fields: {},
    });
    const add = <T>(
      into: Record<string, T>,
      from: Record<string, T> = {},
      what: string,
    ) => {
      for (const [key, value] of Object.entries(from)) {
        if (Object.hasOwn(into, key)) {
          throw new Error(`${name}: the ${what} ${key} is declared twice.`);
        }
        into[key] = value;
      }
    };
    // CASL reads `manage` as every action: a permission of it would grant them all.
    if (declared.actions && Object.hasOwn(declared.actions, 'manage')) {
      throw new Error(
        `${name}: "manage" is CASL's word for every action: name the action otherwise.`,
      );
    }
    add(subject.actions, declared.actions, 'action');
    add(subject.conditions, declared.conditions, 'condition');
    add(subject.fields, declared.fields, 'field');
    if (declared.deletedAt) {
      if (subject.deletedAt) {
        throw new Error(`${name}: deletedAt is declared twice.`);
      }
      subject.deletedAt = declared.deletedAt;
    }
  }

  /** A declared system job, or undefined. */
  systemJob(key: string): SystemJobDefinition | undefined {
    return this.systemJobs.get(key);
  }

  /** Checks a permission against the catalog, and normalizes its parameters and fields. */
  validate(
    input: PermissionInput,
  ): { ok: true; value: PermissionInput } | { ok: false; error: string } {
    const subject = Object.hasOwn(this.subjects, input.subject)
      ? this.subjects[input.subject]
      : undefined;
    if (!subject) {
      return { ok: false, error: `Unknown subject ${input.subject}.` };
    }
    const allowed = Object.hasOwn(subject.actions, input.action)
      ? subject.actions[input.action]
      : undefined;
    if (!allowed) {
      return {
        ok: false,
        error: `Unknown action ${input.action} on ${input.subject}.`,
      };
    }
    const conditions: PermissionInput['conditions'] = [];
    for (const condition of input.conditions) {
      if (!allowed.includes(condition.key)) {
        return {
          ok: false,
          error: `Condition ${condition.key} isn't available for ${input.subject}.${input.action}.`,
        };
      }
      const template = subject.conditions[condition.key]!;
      if (template.params) {
        const parsed = template.params.safeParse(condition.params ?? {});
        if (!parsed.success) {
          return {
            ok: false,
            error: `Condition ${condition.key}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
          };
        }
        conditions.push({
          key: condition.key,
          params: parsed.data as Record<string, unknown>,
        });
      } else {
        conditions.push({ key: condition.key });
      }
    }
    // Left out (or null): every field. []: none of the restrictable ones.
    let fields: string[] | null = null;
    if (input.fields) {
      const unknown = input.fields.filter(
        (field) => !Object.hasOwn(subject.fields, field),
      );
      if (unknown.length) {
        return {
          ok: false,
          error: `${input.subject} has no restrictable field ${unknown.join(', ')}.`,
        };
      }
      fields = [...new Set(input.fields)];
    }
    return {
      ok: true,
      value: {
        subject: input.subject,
        action: input.action,
        conditions,
        fields,
      },
    };
  }

  /**
   * What a stored permission's conditions compare, for this principal:
   * every comparison must hold. `null` when a condition is no longer
   * declared (renamed, removed): the permission then grants nothing, rather
   * than failing every check of the role's members.
   */
  comparisons(
    principal: Principal,
    permission: PermissionInput,
    context: AccessContext,
  ): FieldComparison[] | null {
    const subject = this.subjects[permission.subject];
    const out: FieldComparison[] = [];
    for (const condition of permission.conditions) {
      const template = subject?.conditions[condition.key];
      if (
        !template ||
        !subject.actions[permission.action]?.includes(condition.key)
      ) {
        this.logger.error(
          `A role's ${permission.subject}.${permission.action} names the unknown condition "${condition.key}": it grants nothing.`,
        );
        return null;
      }
      for (const [column, value] of template.where(
        principal,
        condition.params,
        context,
      )) {
        out.push({ field: fieldOf(column), column, values: valuesOf(value) });
      }
    }
    return out;
  }

  /** The fields of `subject` permissions grant one by one. */
  declaredFields(subject: string): string[] {
    return Object.keys(this.subjects[subject]?.fields ?? {});
  }

  /** The declared fields of `subject` marked sensitive (redacted in the audit log). */
  sensitiveFields(subject: string): string[] {
    return Object.entries(this.subjects[subject]?.fields ?? {})
      .filter(([, field]) => field.sensitive)
      .map(([name]) => name);
  }

  /** A soft-deletable subject's `deletedAt` column. */
  deletedAt(subject: string): AnyPgColumn | undefined {
    return this.subjects[subject]?.deletedAt;
  }

  /**
   * A text of the catalogs (`permissions.<path>`), in the request's
   * language or `locale`: the first of `paths` that exists. A missing one
   * is what the i18n policy says (an error in development and tests).
   */
  text(paths: string[], locale?: string): string {
    const keys = paths.map((path) => `permissions.${path}`);
    if (!this.i18n) return keys[0]!;
    const key =
      keys.find((candidate) => this.i18n!.exists(candidate, locale)) ??
      keys[0]!;
    return this.i18n.translate(key, locale ? { locale } : undefined);
  }

  /** A seed role's name and description, in the default language (what the role row keeps). */
  seedRoleTexts(key: string) {
    const locale = this.i18n?.defaultLocale;
    return {
      name: this.text([`seedRoles.${key}.name`], locale),
      description: this.text([`seedRoles.${key}.description`], locale),
    };
  }

  /** A system job's label in the default language: `System: <label>` in the audit log. */
  jobLabel(key: string) {
    return this.text(
      [`systemJobs.${i18nSegment(key)}.label`],
      this.i18n?.defaultLocale,
    );
  }

  /** GET /access/catalog's subjects, in the request's language. */
  view() {
    return Object.entries(this.subjects).map(([subject, declared]) => {
      const own = subjectTextKey(subject);
      return {
        subject,
        label: this.text([`${own}.label`]),
        fields: Object.entries(declared.fields).map(([field, details]) => ({
          field,
          label: this.text([`${own}.fields.${field}`]),
          sensitive: details.sensitive ?? false,
        })),
        actions: Object.entries(declared.actions).map(([action, keys]) => ({
          action,
          label: this.text([`${own}.actions.${action}`]),
          conditions: keys.map((key) => {
            const template = declared.conditions[key]!;
            const text = (part: string) =>
              this.text([
                `${own}.conditions.${key}.${part}`,
                ...(template.text
                  ? [`conditions.${template.text}.${part}`]
                  : []),
              ]);
            return {
              key,
              label: text('label'),
              description: text('description'),
              input: template.input
                ? { ...template.input, label: text('input') }
                : null,
            };
          }),
        })),
      };
    });
  }

  /** GET /access/catalog's system jobs: who acts without a user, and what each may do. */
  systemJobsView() {
    return [...this.systemJobs.values()].map((job) => ({
      key: job.key,
      actor: `system:${job.key}`,
      label: this.text([`systemJobs.${i18nSegment(job.key)}.label`]),
      description: this.text([
        `systemJobs.${i18nSegment(job.key)}.description`,
      ]),
      permissions: job.permissions.map((permission) => ({
        subject: permission.subject,
        action: permission.action,
        conditions: permission.conditions,
        fields: permission.fields ?? null,
      })),
    }));
  }
}

/** A name as one segment of an i18n key: the catalogs split keys on `.`. */
export const i18nSegment = (name: string) => name.replaceAll('.', '_');

/**
 * Where a subject's texts are in the catalogs: under its name in kebab case
 * (`MailSuppression` → `permissions.mail-suppression`).
 */
export const subjectTextKey = (subject: string) =>
  subject.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
