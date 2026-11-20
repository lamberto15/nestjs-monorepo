import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { principalKey, type Principal } from '../auth/principal.js';

/**
 * How a module declares its permissions (README.md): the subjects it owns,
 * their actions, the conditions an administrator may attach, the fields a
 * permission may grant one by one, what API clients and system jobs may
 * do, and what the seed roles get. A module registers its declaration with
 * `AccessModule.forFeature(DECLARATION)` in its own imports; the catalog
 * is what was registered. Texts are in the module's `i18n/<locale>.json`
 * under `permissions.<subject in kebab case>` (PermissionCatalog).
 */

/**
 * What conditions may read besides the principal, loaded with its
 * permissions: its organizational units (current memberships only; the
 * organization module provides them). Empty for API clients and the system.
 */
export interface AccessContext {
  /** The units it is a current member (or lead) of. */
  directUnitIds: readonly string[];
  /** Those, and every unit below them. */
  unitIdsAndBelow: readonly string[];
  /** Those, and every unit above them (their parent, its parent, up to the top). */
  unitIdsAndAbove: readonly string[];
  /** The units it currently leads, and every unit below them. */
  ledUnitIdsAndBelow: readonly string[];
}

/** The context of a principal with no units. */
export const NO_UNITS: AccessContext = Object.freeze({
  directUnitIds: [],
  unitIdsAndBelow: [],
  unitIdsAndAbove: [],
  ledUnitIdsAndBelow: [],
});

/** A value a column is compared with: one value (equals), or a list (one of; empty matches nothing). */
export type ConditionValue =
  | string
  | number
  | boolean
  | readonly (string | number | boolean)[]
  | undefined;

/** A column and the value (or values) it must hold. `undefined` matches nothing. */
export type Comparison = readonly [column: AnyPgColumn, value: ConditionValue];

/**
 * A condition an administrator may attach to an action, written once: the
 * columns it compares, each with a value or a list of values, all of which
 * must hold. AccessService derives both forms from it: the CASL condition
 * a record is checked with (keyed by each column's property name, so the
 * record is the row as Drizzle returns it) and the SQL filter of lists
 * (`eq`, `inArray`; an empty list or `undefined` matches nothing).
 *
 * ```ts
 * mine: { text: 'mine', where: (principal) => [[notes.ownerId, principalKey(principal)]] },
 * draft: { where: () => [[notes.status, 'draft']] },
 * inMyUnits: { text: 'inMyUnits', where: (_p, _params, context) => [[notes.unitId, context.directUnitIds]] },
 * ```
 */
export interface Condition<P = undefined> {
  /**
   * A shared condition's texts (`permissions.conditions.<text>` in the
   * catalogs: `mine`, `inMyUnits`), when its subject has none of its own.
   */
  text?: string;
  /** Validates the parameters the access API receives for it. */
  params?: z.ZodType<P>;
  /** For a frontend: the parameter's input, its label in the texts (`.input`). */
  input?: { name: string; type: 'text' | 'cents' };
  where(
    principal: Principal,
    params: P,
    context: AccessContext,
  ): readonly Comparison[];
}

export interface SubjectDefinition {
  /** Each action, with the keys of the subject's conditions it may carry. */
  actions?: Record<string, readonly string[]>;
  conditions?: Record<string, Condition<any>>;
  /**
   * The fields a permission may grant or withhold one by one: a permission
   * with `fields` grants only those. Fields not listed go with any
   * permission on the subject. `sensitive`: personal or secret data,
   * redacted in audit entries.
   */
  fields?: Record<string, { sensitive?: boolean }>;
  /**
   * A soft-deletable subject's `deletedAt` column: a deleted record can
   * only be restored (`can()`), and lists see live rows only unless they
   * ask for the recycle bin (`sqlFilter(…, { deleted: true })`).
   */
  deletedAt?: AnyPgColumn;
}

/** A permission as stored: an action on a subject, when every condition holds. */
export interface PermissionInput {
  subject: string;
  action: string;
  conditions: { key: string; params?: Record<string, unknown> }[];
  /**
   * Only these of the subject's declared (restrictable) fields: `[]` grants
   * none of them. Absent (or null): all of them.
   */
  fields?: string[] | null;
}

/**
 * A role every new tenant starts with, editable afterwards. Declarations
 * with the same key are one role: each adds its permissions. Its name and
 * description are texts: `permissions.seedRoles.<key>.name|description`.
 */
export interface SeedRole {
  key: string;
  permissions: PermissionInput[];
}

/**
 * Work that runs without a user, as the system principal `system:<key>`
 * (SystemContext.run()): `permissions` is all it may do, read like an API
 * client's (conditions with the job as the principal); never `all.manage`.
 * `[]` for a job that checks none. Texts:
 * `permissions.systemJobs.<key>.label|description` (the label names it in
 * the audit log: `System: <label>`).
 */
export interface SystemJobDefinition {
  /** Lowercase words joined by `-` (`.` between groups): `account-deletion`. */
  key: string;
  permissions: PermissionInput[];
}

export interface PermissionsDefinition {
  /**
   * The subjects, by name. A subject another module declared too is
   * extended: its actions, conditions and fields add up (a key declared
   * twice fails the start), as `Access` gets `manageOrganizationalUnits`
   * from the organization module.
   */
  subjects?: Record<string, SubjectDefinition>;
  /**
   * What every API client may do, fixed in code, besides its roles.
   * Conditions read the client as the principal.
   */
  clientPermissions?: PermissionInput[];
  seedRoles?: SeedRole[];
  systemJobs?: SystemJobDefinition[];
}

/** Declares permissions with their types checked. */
export const definePermissions = <T extends PermissionsDefinition>(
  definition: T,
) => definition;

/** Declares a system job (list it in its module's `definePermissions({ systemJobs })`). */
export const defineSystemJob = <T extends SystemJobDefinition>(job: T) => job;

/** The built-in administrator's one permission: anything, on anything. */
export const ALL: PermissionInput = {
  subject: 'all',
  action: 'manage',
  conditions: [],
};

export const isAll = (permission: PermissionInput) =>
  permission.subject === 'all' && permission.action === 'manage';

/**
 * "Created by me": records whose `column` holds the principal that created
 * them (`user:<id>`, `client:<id>`, `system:<job>`).
 */
export const createdBy = (column: AnyPgColumn): Condition => ({
  text: 'mine',
  where: (principal) => [[column, principalKey(principal)]],
});
