import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  type Condition,
  createdBy,
  definePermissions,
  type PermissionInput,
  type SeedRole,
  type SystemJobDefinition,
} from '../../iam/access/permissions.js';
import {
  UNIT_CONDITION_KEYS,
  unitConditions,
} from '../../iam/organization/unit-conditions.js';
import type { RecordDeclaration } from './record.js';

/** What a feature adds to its records' standard permissions. */
export interface RecordPermissionOptions {
  /** Field-level permissions: the fields a permission may grant one by one. */
  fields?: Record<string, { sensitive?: boolean }>;
  /** Conditions of the feature's own, besides `mine` and the unit conditions. */
  conditions?: Record<string, Condition<any>>;
  /** Actions of its own (with the conditions each may carry), or a standard one replaced. */
  actions?: Record<string, readonly string[]>;
  /** Added to what every API client may do. */
  clientPermissions?: PermissionInput[];
  /** Added to the seed roles (same key: merged). */
  seedRoles?: SeedRole[];
  systemJobs?: SystemJobDefinition[];
}

/** The standard actions: `restore` with a recycle bin. */
export const recordActions = (declaration: RecordDeclaration) => [
  'read',
  'create',
  'update',
  'delete',
  ...(declaration.softDelete ? ['restore'] : []),
];

/**
 * A record's permissions (definePermissions, iam/access), from its
 * declaration: the condition `mine` (and with units `inMyUnits`,
 * `inMyUnitsAndBelow`, `inMyUnitsAndAbove`, `inUnitsILeadAndBelow`), each written once as column
 * and value; the actions read, create, update, delete (and restore with a
 * recycle bin); the recycle bin's `deletedAt`; with `clientAccess: 'own'`
 * an API client's own records; the seed roles' grants (`grants`). Register
 * it in the feature module: `AccessModule.forFeature(INVOICE_PERMISSIONS)`.
 *
 * ```ts
 * export const INVOICE_PERMISSIONS = recordPermissions(INVOICE, invoices, { fields: { total: {} } });
 * ```
 */
export function recordPermissions(
  declaration: RecordDeclaration,
  table: object,
  options: RecordPermissionOptions = {},
) {
  const { subject } = declaration;
  const t = table as {
    ownerId: AnyPgColumn;
    unitId?: AnyPgColumn;
    deletedAt?: AnyPgColumn;
  };
  const read = declaration.unit ? ['mine', ...UNIT_CONDITION_KEYS] : ['mine'];
  const own = (action: string): PermissionInput => ({
    subject,
    action,
    conditions: action === 'create' ? [] : [{ key: 'mine' }],
  });
  const actions = recordActions(declaration);
  return definePermissions({
    subjects: {
      [subject]: {
        actions: {
          read,
          create: [],
          update: ['mine'],
          delete: ['mine'],
          ...(declaration.softDelete && { restore: read }),
          ...options.actions,
        },
        conditions: {
          mine: createdBy(t.ownerId),
          ...(declaration.unit && unitConditions(t.unitId!)),
          ...options.conditions,
        },
        ...(options.fields && { fields: options.fields }),
        ...(declaration.softDelete && { deletedAt: t.deletedAt! }),
      },
    },
    clientPermissions: [
      ...(declaration.clientAccess === 'own' ? actions.map(own) : []),
      ...(options.clientPermissions ?? []),
    ],
    seedRoles: [
      ...(declaration.grants === 'none'
        ? []
        : standardRoles(declaration, actions.map(own))),
      ...(options.seedRoles ?? []),
    ],
    ...(options.systemJobs && { systemJobs: options.systemJobs }),
  });
}

/** `grants: 'standard'`: editors their own, unit leads their units' (with units), viewers every record. */
function standardRoles(
  declaration: RecordDeclaration,
  own: PermissionInput[],
): SeedRole[] {
  const { subject } = declaration;
  return [
    { key: 'editor', permissions: own },
    ...(declaration.unit
      ? [
          {
            key: 'unit-lead',
            permissions: [
              {
                subject,
                action: 'read',
                conditions: [{ key: 'inUnitsILeadAndBelow' }],
              },
            ],
          },
        ]
      : []),
    {
      key: 'viewer',
      permissions: [{ subject, action: 'read', conditions: [] }],
    },
  ];
}
