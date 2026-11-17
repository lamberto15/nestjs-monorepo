import { text } from 'drizzle-orm/pg-core';

/** The column marks add to a record's table: `recordTable(ITEM, { columns: markColumns() })`. */
export const markColumns = () => ({
  /** The last mark a create or an update set (the `creating`/`updating` hooks). */
  lastMark: text('last_mark'),
});
