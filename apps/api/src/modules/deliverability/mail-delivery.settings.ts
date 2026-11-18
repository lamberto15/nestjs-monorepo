import { z } from 'zod';
import { MAIL_DELIVERY_MODES } from '../../core/mail/mail-delivery.js';
import { defineQuota } from '../quotas/quota.js';
import { defineSettings, setting } from '../settings/settings.types.js';

/**
 * Which mail leaves: `all`; `essential`, only the mail a person needs to
 * sign in or recover an account (`@EssentialMail()`, or sent as essential);
 * `off`, none. The operators set it for every tenant, enforced
 * (`PUT /v1/settings/mail.delivery/platform`), to stop a mail storm without
 * a deploy; a tenant administrator may restrict their own tenant's. The
 * environment's MAIL_DELIVERY is the ceiling: the setting can only be stricter.
 */
export const MAIL_DELIVERY_SETTING = setting({
  key: 'mail.delivery',
  label: 'Mail delivery',
  description:
    'Which mail leaves for this tenant: all, only essential (sign-in, password reset, verification), or none.',
  schema: z.enum(MAIL_DELIVERY_MODES),
  scopes: ['tenant'],
  public: false,
  default: 'all',
});

/** Past this share of a tenant's daily mail quota, only essential mail goes. */
export const MAIL_ESSENTIAL_ONLY_PERCENT_SETTING = setting({
  key: 'mail.essentialOnlyPercent',
  label: 'Essential mail only from (%)',
  description:
    'Past this share of the daily mail limit, only essential mail (sign-in, password reset, verification) is sent.',
  schema: z.number().int().min(1).max(100),
  default: 90,
  scopes: [],
  public: false,
});

export const MAIL_DELIVERY_SETTINGS = defineSettings([
  MAIL_DELIVERY_SETTING,
  MAIL_ESSENTIAL_ONLY_PERCENT_SETTING,
]);

/** The mails a tenant may queue per UTC day; unlimited until the operators set one. */
export const MAILS_PER_DAY = defineQuota({
  key: 'mail.perDay',
  label: 'mails a day',
  description:
    'Mails queued per UTC day; past mail.essentialOnlyPercent of it, only essential mail goes.',
  kind: 'rate',
  period: 'day',
});
