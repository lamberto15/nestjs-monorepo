import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  apiClientRoles,
  roles,
  userRoles,
} from '../../iam/access/access.tables.js';
import { apiClients, memberships } from '../../iam/auth/auth.tables.js';
import { organizationalUnits } from '../../iam/organization/organization.tables.js';
import { platformSettingValues, settingOverrides } from './settings.tables.js';
import type { SettingScope } from './settings.types.js';

type NewOverride = typeof settingOverrides.$inferInsert;
type NewPlatformValue = typeof platformSettingValues.$inferInsert;

/** Which override: a setting at one scope. */
interface OverrideKey {
  key: string;
  scope: SettingScope;
  scopeId: string;
}

/**
 * The settings' queries: the tenant's overrides, the platform values, and
 * the principals, units and roles a scope or a rule names, in the caller's
 * tenant and transaction (`@InjectTransaction()`).
 */
@Injectable()
export class SettingsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** Every override of the current tenant. */
  overrides() {
    return this.db.select().from(settingOverrides);
  }

  async findOverride(at: OverrideKey) {
    const [row] = await this.db
      .select()
      .from(settingOverrides)
      .where(this.override(at));
    return row;
  }

  async saveOverride(
    at: OverrideKey,
    columns: Omit<NewOverride, keyof OverrideKey>,
  ) {
    const [row] = await this.db
      .insert(settingOverrides)
      .values({ ...at, ...columns })
      .onConflictDoUpdate({
        target: [
          settingOverrides.tenantId,
          settingOverrides.key,
          settingOverrides.scope,
          settingOverrides.scopeId,
        ],
        set: columns,
      })
      .returning();
    return row!;
  }

  /** Deletes an override; the row it was, if there was one. */
  async deleteOverride(at: OverrideKey) {
    const [row] = await this.db
      .delete(settingOverrides)
      .where(this.override(at))
      .returning();
    return row;
  }

  /** A person's own values (`user` scope), for their export. */
  ownValuesOf(key: string) {
    return this.db
      .select({
        id: settingOverrides.id,
        key: settingOverrides.key,
        value: settingOverrides.value,
        updatedAt: settingOverrides.updatedAt,
      })
      .from(settingOverrides)
      .where(this.own(key));
  }

  async deleteOwnValuesOf(key: string) {
    await this.db.delete(settingOverrides).where(this.own(key));
  }

  /** Every platform value. */
  platformValues() {
    return this.db.select().from(platformSettingValues);
  }

  async findPlatformValue(key: string) {
    const [row] = await this.db
      .select()
      .from(platformSettingValues)
      .where(eq(platformSettingValues.key, key));
    return row;
  }

  async savePlatformValue(key: string, columns: Omit<NewPlatformValue, 'key'>) {
    const [row] = await this.db
      .insert(platformSettingValues)
      .values({ key, ...columns })
      .onConflictDoUpdate({ target: platformSettingValues.key, set: columns })
      .returning();
    return row!;
  }

  /** Deletes a platform value; the row it was, if there was one. */
  async deletePlatformValue(key: string) {
    const [row] = await this.db
      .delete(platformSettingValues)
      .where(eq(platformSettingValues.key, key))
      .returning();
    return row;
  }

  /** The roles a user or an API client holds now (unexpired grants). */
  async liveRoleIdsOf(kind: 'user' | 'client', id: string) {
    const grants = kind === 'user' ? userRoles : apiClientRoles;
    const holder = kind === 'user' ? userRoles.userId : apiClientRoles.clientId;
    const rows = await this.db
      .select({ roleId: grants.roleId })
      .from(grants)
      .where(
        and(
          eq(holder, id),
          or(isNull(grants.expiresAt), gt(grants.expiresAt, new Date())),
        ),
      );
    return rows.map((row) => row.roleId);
  }

  /** The tenant's role ids. */
  async roleIds() {
    const rows = await this.db.select({ id: roles.id }).from(roles);
    return rows.map((row) => row.id);
  }

  /** A unit's id as stored, if the tenant has it. */
  async findUnitId(id: string) {
    const [unit] = await this.db
      .select({ id: organizationalUnits.id })
      .from(organizationalUnits)
      .where(eq(organizationalUnits.id, id));
    return unit?.id;
  }

  /** Whether the user is a member of the tenant. */
  async isMember(userId: string, tenantId: string) {
    const found = await this.db
      .select({ id: memberships.userId })
      .from(memberships)
      .where(
        and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)),
      );
    return found.length > 0;
  }

  async clientExists(id: string) {
    const found = await this.db
      .select({ id: apiClients.id })
      .from(apiClients)
      .where(eq(apiClients.id, id));
    return found.length > 0;
  }

  private override({ key, scope, scopeId }: OverrideKey) {
    return and(
      eq(settingOverrides.key, key),
      eq(settingOverrides.scope, scope),
      eq(settingOverrides.scopeId, scopeId),
    );
  }

  private own(key: string) {
    return and(
      eq(settingOverrides.scope, 'user'),
      eq(settingOverrides.scopeId, key),
    );
  }
}
