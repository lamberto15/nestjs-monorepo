import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, arrayContains, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { users } from '../../iam/auth/auth.tables.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { comments } from './comments.tables.js';

/** What a deleted person's comments say, and who wrote them. */
const DELETED_BODY = '[deleted]';
const ANONYMIZED_AUTHOR = 'anonymous';

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The person's own comments: in their export, newest first (not the names of
 * those they mentioned: other people's data). At the deletion the comments
 * stay, so the conversation keeps its shape, with "[deleted]" as the text
 * and `anonymous` as the author. Where others mentioned the person, the
 * mention goes, and so does their address in the text.
 */
@PersonalData({ name: 'comments', scopes: ['tenant'] })
@Injectable()
export class CommentsPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async *rows({ key }: PersonalDataSubject) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.db
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.author, key),
            cursor ? lt(comments.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(comments.id))
        .limit(1000);
      if (rows.length === 0) return;
      yield rows;
      cursor = rows[rows.length - 1]!.id;
    }
  }

  async erase({ userId, key }: PersonalDataSubject) {
    await this.db
      .update(comments)
      .set({ body: DELETED_BODY, author: ANONYMIZED_AUTHOR, mentions: [] })
      .where(eq(comments.author, key));
    await this.db
      .update(comments)
      .set({ resolvedBy: ANONYMIZED_AUTHOR })
      .where(eq(comments.resolvedBy, key));
    const [account] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    const pattern = `@(${[account?.email, key]
      .filter((name): name is string => !!name)
      .map(escapeRegExp)
      .join('|')})`;
    // The text too where the mention was dropped (they could not read the
    // record, or came after the twentieth): a scan, but the job is nightly.
    await this.db
      .update(comments)
      .set({
        body: sql`regexp_replace(${comments.body}, ${pattern}, '@[deleted]', 'gi')`,
        mentions: sql`array_remove(${comments.mentions}, ${key})`,
      })
      .where(
        or(
          arrayContains(comments.mentions, [key]),
          sql`${comments.body} ~* ${pattern}`,
        ),
      );
  }
}
