import { sql } from 'drizzle-orm';
import { jsonb, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';
import type { ImportMapping } from './import-mapping.js';

/**
 * Column mappings kept under a name for an import: which header of a file
 * fills which column of the template. The tenant's, for whoever may run
 * that import; checked again against the record's create body and the
 * caller's field permissions whenever one is used.
 */
export const importMappings = tenantTable(
  'import_mappings',
  {
    id: uuidPk(),
    /** The import's name: the record's path, `invoices`. */
    importer: text('importer').notNull(),
    name: text('name').notNull(),
    /** The file header to the template column (null: ignored). */
    mapping: jsonb('mapping').$type<ImportMapping>().notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('import_mappings_name_idx').on(
      t.tenantId,
      t.importer,
      sql`lower(${t.name})`,
    ),
  ],
);

export type ImportMappingRow = typeof importMappings.$inferSelect;
