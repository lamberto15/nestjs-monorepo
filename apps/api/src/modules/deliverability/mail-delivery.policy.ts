import { Injectable } from '@nestjs/common';
import {
  type MailDelivery,
  MailDeliveryPolicy,
} from '../../core/mail/mail-delivery.js';
import { currentTenantScope } from '../../core/tenancy/tenant-scope.js';
import { QuotasService } from '../quotas/quotas.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  MAIL_DELIVERY_SETTING,
  MAIL_ESSENTIAL_ONLY_PERCENT_SETTING,
  MAILS_PER_DAY,
} from './mail-delivery.settings.js';

/**
 * core/mail's delivery rules (`@MailDeliveryPolicy()`, found by discovery):
 * the `mail.delivery` setting and the tenant's `mail.perDay` quota.
 *
 * A tenant's non-essential mail is withheld once the day's count reaches
 * `mail.essentialOnlyPercent` of its limit; essential mail is counted and
 * goes, up to the limit itself (past it the count stops, the mail still goes).
 * The threshold is read, then the mail counted: parallel mails can pass it by
 * a few, never the limit (the quota counter is atomic).
 */
@MailDeliveryPolicy()
@Injectable()
export class MailDeliveryRules implements MailDelivery {
  constructor(
    private readonly settings: SettingsService,
    private readonly quotas: QuotasService,
  ) {}

  mode() {
    return this.settings.get(MAIL_DELIVERY_SETTING);
  }

  async consume({ essential }: { essential: boolean }) {
    const tenantId = currentTenantScope()?.tenantId;
    if (!tenantId) return true;
    if (!essential) {
      const limit = await this.quotas.limitOf(MAILS_PER_DAY, tenantId);
      if (limit !== null) {
        const percent = await this.settings.get(
          MAIL_ESSENTIAL_ONLY_PERCENT_SETTING,
        );
        const used = await this.quotas.used(MAILS_PER_DAY, tenantId);
        if (used >= Math.floor((limit * percent) / 100)) return false;
      }
    }
    const { allowed } = await this.quotas.tryConsume(
      MAILS_PER_DAY,
      1,
      tenantId,
    );
    return allowed || essential;
  }
}
