import { integer, primaryKey, text } from 'drizzle-orm/pg-core';
import { timestamps } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

export const LOGO_VARIANTS = ['light', 'dark'] as const;
export type LogoVariant = (typeof LOGO_VARIANTS)[number];

/**
 * A tenant's logos, at most one per variant: the logo everywhere, and an
 * optional one for the web app's dark theme. `key` is the file on the
 * private disk; a new upload gets a new key, so the old file can go once
 * this row names the new one.
 */
export const brandingLogos = tenantTable(
  'branding_logos',
  {
    variant: text('variant', { enum: LOGO_VARIANTS }).notNull(),
    key: text('key').notNull(),
    /** The type the file's bytes said at upload (PNG, JPEG or WebP). */
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.variant] })],
);
