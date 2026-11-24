import { Transactional } from '@nestjs-cls/transactional';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { NotificationCatalog } from './notifications.catalog.js';
import { notificationsConfig } from './notifications.config.js';
import { offered } from './notifications.preferences.js';
import { NotificationsRepository } from './notifications.repository.js';
import type { PreferenceOverrides } from './notifications.types.js';
import type { QuietHours } from './quiet-hours.js';

/**
 * A person's choices about being told: per type and channel, and quiet
 * hours. Global (the same in every tenant), stored as overrides of the
 * types' defaults. Changes are audited (`notificationPreferences.updated`,
 * `notificationQuietHours.updated`).
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly repository: NotificationsRepository,
    private readonly catalog: NotificationCatalog,
    private readonly audit: AuditService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  /** A recipient's stored overrides (empty when none). */
  async overrides(recipient: string): Promise<PreferenceOverrides> {
    return this.repository.overridesOf(recipient);
  }

  /** A recipient's quiet hours, or null. */
  async quietHoursOf(recipient: string): Promise<QuietHours | null> {
    return this.repository.quietHoursOf(recipient);
  }

  /** The caller's effective settings, per type, for the channels they may set. */
  async preferences(principal: Principal) {
    return this.effective(
      principal,
      await this.overrides(principalKey(principal)),
    );
  }

  /**
   * Replaces the caller's overrides with `raw`, checked against the
   * declared types and their channels (a 400 naming `<type>.<channel>`; a
   * mandatory type can't be switched off). Audited with what changed.
   */
  @Transactional()
  async updatePreferences(principal: Principal, raw: unknown, ip?: string) {
    const parsed = this.catalog.preferencesSchema(principal).safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The preferences are invalid.',
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const recipient = principalKey(principal);
    // Only what was set: a type or channel left out keeps its default.
    const settings: PreferenceOverrides = {};
    for (const [type, channels] of Object.entries(parsed.data)) {
      const given = Object.fromEntries(
        Object.entries(channels ?? {}).filter(
          ([, value]) => value !== undefined,
        ),
      );
      if (Object.keys(given).length > 0) settings[type] = given;
    }
    const from = await this.overrides(recipient);
    await this.repository.saveOverrides(recipient, settings);
    await this.audit.record(principal, {
      action: 'notificationPreferences.updated',
      targetType: 'notificationPreferences',
      targetId: recipient,
      details: { from, to: settings },
      ip,
    });
    return this.effective(principal, settings);
  }

  /** The caller's quiet hours with the time zone their clock follows (theirs, else the deployment's). */
  async quietHours(principal: UserPrincipal) {
    const quiet = await this.quietHoursOf(principalKey(principal));
    return {
      quietHours: quiet
        ? { ...quiet, timezone: principal.timezone ?? this.config.timezone }
        : null,
    };
  }

  /** Sets (or, with null, clears) the caller's quiet hours. Audited. */
  @Transactional()
  async setQuietHours(
    principal: UserPrincipal,
    quiet: QuietHours | null,
    ip?: string,
  ) {
    const recipient = principalKey(principal);
    const from = await this.quietHoursOf(recipient);
    await this.repository.saveQuietHours(recipient, quiet);
    await this.audit.record(principal, {
      action: 'notificationQuietHours.updated',
      targetType: 'notificationPreferences',
      targetId: recipient,
      details: { from, to: quiet },
      ip,
    });
    return this.quietHours(principal);
  }

  private effective(principal: Principal, overrides: PreferenceOverrides) {
    return {
      types: Object.fromEntries(
        this.catalog.declarations().map((declaration) => {
          const settings = this.catalog.effective(
            declaration,
            overrides[declaration.type],
            principal,
          );
          // Only what the caller is offered: not a type's fixed channels.
          const own = offered(declaration, this.catalog.settable(principal));
          return [
            declaration.type,
            Object.fromEntries(
              Object.entries(settings).filter(([name]) =>
                (own as string[]).includes(name),
              ),
            ),
          ];
        }),
      ),
    };
  }
}
