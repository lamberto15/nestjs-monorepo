import { index, text, uuid } from 'drizzle-orm/pg-core';
import { at, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { users } from '../auth/auth.tables.js';

/**
 * Break-glass grants, kept in the operators' tenant (its scope's tenant):
 * which operator may read which other tenant, why, and until when. Never
 * extended; ended early by the operator, or by the clock.
 */
export const breakGlassGrants = tenantTable(
  'break_glass_grants',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetTenantId: uuid('target_tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    expiresAt: at('expires_at').notNull(),
    endedAt: at('ended_at'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('break_glass_grants_user_target_idx').on(
      t.tenantId,
      t.userId,
      t.targetTenantId,
    ),
  ],
);

export type BreakGlassGrant = typeof breakGlassGrants.$inferSelect;
