import { DiscoveryService } from '@nestjs/core';

/**
 * Why a recipient is not written to (docs/deliverability.md):
 * `hard_bounce` (the mailbox doesn't exist), `soft_bounce` (it refused
 * MAIL_SOFT_BOUNCE_THRESHOLD deliveries in a row), `complaint` (the
 * person reported a mail as spam), `manual` (an administrator added it).
 */
export const SUPPRESSION_REASONS = [
  'hard_bounce',
  'soft_bounce',
  'complaint',
  'manual',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** What the sender learns about one recipient. */
export type SuppressionVerdict =
  { send: true } | { send: false; reason: SuppressionReason };

/**
 * The suppression list, as the mail queue's worker asks it before a send.
 * Core can't import the module that keeps the list (modules/deliverability),
 * so that module marks its provider `@MailSuppressionList()` and the worker
 * finds it; with none in the application, mail goes to everyone.
 */
export interface MailSuppression {
  /**
   * The verdict for each address. `essential` is the mail's marker
   * (`@EssentialMail()`): one the person asked for or must be told
   * (a password reset, a deletion notice), which still goes to an
   * address that complained; never to one that bounced or was listed by
   * hand. `skipped` recipients are counted on their entry.
   */
  check(
    addresses: readonly string[],
    options: { essential: boolean; mail: string },
  ): Promise<Map<string, SuppressionVerdict>>;
}

/** Marks the provider that answers for the suppression list (one per application). */
export const MailSuppressionList = DiscoveryService.createDecorator();

/**
 * An address as the suppression list keys it: trimmed, lower case (the
 * local part is case-insensitive in practice, and providers report what
 * they sent to). `@nestjs/mail` has already put the domain in ASCII.
 */
export const normalizeAddress = (address: string) =>
  address.trim().toLowerCase();
