import { z } from 'zod';
import { defineNotifications } from '../notifications/notifications.types.js';

/** What a notification about a comment carries (the texts' placeholders, and what a client needs to act). */
const data = z.object({
  subject: z.string(),
  recordId: z.uuid(),
  commentId: z.uuid(),
  title: z.string(),
  by: z.string(),
  excerpt: z.string(),
});

/**
 * What comments tell people (texts: `i18n/en.json`, under `notifications.comment`).
 * The watchers of a record hear `comment.added`, collapsed per record.
 */
export const COMMENT_NOTIFICATIONS = defineNotifications([
  // Someone mentioned the recipient in a comment on a record they may read.
  { type: 'comment.mentioned', email: 'immediate', data },
  // Someone answered the recipient's comment (a reply in their thread).
  { type: 'comment.replied', email: 'immediate', data },
  // A new comment on a record the recipient watches.
  { type: 'comment.added', email: false, data },
]);
