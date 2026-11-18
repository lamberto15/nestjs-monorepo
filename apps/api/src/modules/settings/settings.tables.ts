import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import {
  encrypted,
  encryptedText,
} from '../../core/encryption/encrypted-columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';
import type { FlagRule } from './settings.rules.js';
import type { SettingScope } from './settings.types.js';
import { secretColumns } from '../../core/database/secret-columns.js';

/**
 * The values administrators (and users, for their own preferences) set for
 * the declared settings: one row per setting and scope. Declarations and
 * defaults live in code; a row only holds what differs.
 */
export const settingOverrides = tenantTable(
  'setting_overrides',
  {
    id: uuidPk(),
    /** A declared key: `notes.publishDelay`. */
    key: text('key').notNull(),
    scope: text('scope').$type<SettingScope>().notNull(),
    /** The unit's id, the principal's key, or '' for the tenant scope. */
    scopeId: text('scope_id').notNull().default(''),
    /** The value (checked by the declaration's schema); null: only `rollout` applies (a flag), or it is a secret. */
    value: jsonb('value'),
    /** The value of a `secret` setting, encrypted. */
    secret: encryptedText('secret'),
    /** A flag's rollout percentage (0-100), tenant scope only. */
    rollout: integer('rollout'),
    /** A flag's targeting rules, first match wins, before the value and the rollout. */
    rules: jsonb('rules').$type<FlagRule[]>().notNull().default([]),
    /** Who set it: a principal key. */
    updatedBy: text('updated_by').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('setting_overrides_key_scope_idx').on(
      t.tenantId,
      t.key,
      t.scope,
      t.scopeId,
    ),
  ],
);

/**
 * What the deployment's operators set for every tenant: one row per
 * setting. Not a tenant table: it holds across tenants, and is read outside
 * any tenant too. Below each tenant's own values (the runtime default), or
 * above them all when `enforced` (a kill switch).
 */
export const platformSettingValues = pgTable('platform_setting_values', {
  id: uuidPk(),
  key: text('key').notNull().unique(),
  value: jsonb('value'),
  secret: encryptedText('secret'),
  /** Beats every tenant's, unit's and principal's value (with a value only). */
  enforced: boolean('enforced').notNull().default(false),
  rollout: integer('rollout'),
  rules: jsonb('rules').$type<FlagRule[]>().notNull().default([]),
  updatedBy: text('updated_by').notNull(),
  ...timestamps(),
});

// Declared, not listed with @EncryptedColumns: only a deployment that
// declares a `secret` setting needs DATA_ENCRYPTION_KEYS (SettingsCatalog
// refuses one without), so the boot check must not demand it of every app.
encrypted(settingOverrides.secret);
encrypted(platformSettingValues.secret);

secretColumns(settingOverrides, [settingOverrides.secret]);
