import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { CommentsRepository } from './comments.repository.js';

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
  constructor(private readonly repository: CommentsRepository) {}

  async *rows({ key }: PersonalDataSubject) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.repository.ofAuthor(key, cursor, 1000);
      if (rows.length === 0) return;
      yield rows;
      cursor = rows[rows.length - 1]!.id;
    }
  }

  async erase({ userId, key }: PersonalDataSubject) {
    await this.repository.blankOfAuthor(key, DELETED_BODY, ANONYMIZED_AUTHOR);
    await this.repository.renameResolver(key, ANONYMIZED_AUTHOR);
    const email = await this.repository.emailOf(userId);
    const pattern = `@(${[email, key]
      .filter((name): name is string => !!name)
      .map(escapeRegExp)
      .join('|')})`;
    // The text too where the mention was dropped (they could not read the
    // record, or came after the twentieth): a scan, but the job is nightly.
    await this.repository.dropMentions(key, pattern);
  }
}
