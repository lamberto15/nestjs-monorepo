import { index, integer, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

/** What a favorite points at: a record, a page of the app, or a saved view. */
export const FAVORITE_KINDS = ['record', 'page', 'view'] as const;
export type FavoriteKind = (typeof FAVORITE_KINDS)[number];

/**
 * A person's favorites, in their order: the records and pages they pin for
 * quick navigation (the web app's menu). Their own alone.
 */
export const favorites = tenantTable(
  'favorites',
  {
    id: uuidPk(),
    /** Whose it is: `user:<id>` or `client:<id>`. */
    owner: text('owner').notNull(),
    kind: text('kind').$type<FavoriteKind>().notNull(),
    /** A record's permission subject (`Note`), a view's list page (`/notes`); empty for a page. */
    subject: text('subject').notNull().default(''),
    /** The record's id, the page's path (`/notes`) or the view's id. */
    target: text('target').notNull(),
    /** The name shown in the menu, as it was when pinned. */
    label: text('label').notNull(),
    /** The place in the owner's list: lower first. */
    position: integer('position').notNull(),
    ...timestamps(),
  },
  (t) => [
    // The same thing twice in one person's favorites is refused (409).
    uniqueIndex('favorites_owner_target_idx').on(
      t.tenantId,
      t.owner,
      t.kind,
      t.subject,
      t.target,
    ),
    // One owner's list in order (GET /favorites).
    index('favorites_owner_position_idx').on(t.owner, t.position),
  ],
);
