import { DiscoveryService } from '@nestjs/core';

/** Which mail leaves: `MAIL_DELIVERY` (the ceiling) and the `mail.delivery` setting. */
export const MAIL_DELIVERY_MODES = ['all', 'essential', 'off'] as const;
export type MailDeliveryMode = (typeof MAIL_DELIVERY_MODES)[number];

/**
 * The run-time rules for a mail before it is queued: the operators' mode and
 * the current tenant's daily budget. Core can't import the modules that
 * keep them (modules/deliverability), so that module marks its provider
 * `@MailDeliveryPolicy()` and MailQueue finds it; with none, only the
 * environment's `MAIL_DELIVERY` applies.
 */
export interface MailDelivery {
  /** The mode now, for the current tenant. */
  mode(): Promise<MailDeliveryMode>;
  /**
   * Counts one mail against the current tenant's daily budget; false when a
   * mail that isn't essential must be withheld. Essential mail is counted
   * and always true.
   */
  consume(options: { essential: boolean }): Promise<boolean>;
}

/** Marks the provider that answers for the delivery rules (one per application). */
export const MailDeliveryPolicy = DiscoveryService.createDecorator();

const STRICTNESS: Record<MailDeliveryMode, number> = {
  all: 0,
  essential: 1,
  off: 2,
};

/** The stricter of two modes: the environment is a ceiling the setting can only lower. */
export const stricterMode = (a: MailDeliveryMode, b: MailDeliveryMode) =>
  STRICTNESS[a] >= STRICTNESS[b] ? a : b;
