import type { z } from 'zod';

/** When the email channel sends: at once, or bundled into a digest. */
export type EmailMode = 'immediate' | 'hourly' | 'daily';
export type DigestMode = Exclude<EmailMode, 'immediate'>;

/**
 * A notification type a module declares and registers in its own imports,
 * `NotificationsModule.forFeature(NOTE_NOTIFICATIONS)` (README.md). Its texts are
 * `notifications.<type>.{label,title,body}` in the module's `i18n/<locale>.json`.
 *
 * In-app and realtime are always on; `email` and `push` are the defaults the
 * recipient may change in their preferences (a channel left out is off).
 */
export interface NotificationTypeDeclaration<
  D extends Record<string, unknown> = Record<string, unknown>,
> {
  /** `note.published`: full-stop delimited segments, the catalog's path. */
  type: string;
  /** Users: false (no mail), or when the mail goes. */
  email?: EmailMode | false;
  /** Users with a registered browser: whether it is pushed too. */
  push?: boolean;
  /** The recipient may change a channel's frequency, never switch a channel that is on by default off. */
  mandatory?: boolean;
  /**
   * Channels the recipient is not offered: their default always holds. The
   * security alerts' email, which iam/account mails itself (one mail).
   */
  fixed?: readonly ('email' | 'push')[];
  /** A sign-in alert: push goes at once, through the recipient's quiet hours. */
  urgent?: boolean;
  /** `notify()` without a `key` collapses on the type: one row per recipient, counted up. */
  collapse?: boolean;
  /** Checked by `notify()`; its keys are the placeholders of the title and body. */
  data?: z.ZodType<D>;
}

/** Declares a module's notification types (a typo in a field fails here, not at the first send). */
export const defineNotifications = <
  const T extends readonly NotificationTypeDeclaration<any>[],
>(
  types: T,
) => types;

/** A recipient's overrides of the types' defaults: `{ [type]: { email?, push? } }`. */
export type PreferenceOverrides = Record<string, Record<string, unknown>>;
