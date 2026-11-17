import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DiscoveryService } from '@nestjs/core';
import { I18nService } from '@nestjs/i18n';
import type { Principal } from '../../iam/auth/principal.js';
import { notificationsConfig } from './notifications.config.js';
import {
  type ChannelName,
  effectiveSettings,
  preferencesSchema,
} from './notifications.preferences.js';
import type { NotificationTypeDeclaration } from './notifications.types.js';

/** One `NotificationsModule.forFeature()` declaration, found by the catalog. */
export class NotificationRegistration {
  constructor(readonly types: readonly NotificationTypeDeclaration<any>[]) {}

  toJSON() {
    return `notifications#${this.types.map((type) => type.type).join(',')}`;
  }
}

const TYPE = /^[a-z][\w-]*(\.[\w-]+)+$/;

/**
 * The notification types the modules declared, their texts, and what a
 * recipient's preferences make of them. Checked at start: a type declared
 * twice, a malformed name, or one the English catalog has no texts for stops
 * the app.
 */
@Injectable()
export class NotificationCatalog implements OnModuleInit {
  private readonly byType = new Map<string, NotificationTypeDeclaration<any>>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly i18n: I18nService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  onModuleInit() {
    const registrations = this.discovery
      .getProviders()
      .flatMap((wrapper) =>
        wrapper.instance instanceof NotificationRegistration
          ? [wrapper.instance]
          : [],
      );
    for (const declaration of new Set(registrations.flatMap((r) => r.types))) {
      if (!TYPE.test(declaration.type)) {
        throw new Error(
          `"${declaration.type}" is not a notification type: lowercase, full-stop delimited segments, as in note.published.`,
        );
      }
      if (this.byType.has(declaration.type)) {
        throw new Error(
          `Notification type "${declaration.type}" is declared twice.`,
        );
      }
      for (const part of ['label', 'title', 'body']) {
        const key = `notifications.${declaration.type}.${part}`;
        if (!this.i18n.exists(key, this.i18n.defaultLocale)) {
          throw new Error(
            `The ${this.i18n.defaultLocale} catalog has no ${key}: add it to the declaring module's i18n/${this.i18n.defaultLocale}.json.`,
          );
        }
      }
      this.byType.set(declaration.type, declaration);
    }
  }

  /** The declared types, in declaration order. */
  declarations() {
    return [...this.byType.values()];
  }

  /** A declared type, or undefined (removed since the notification was stored). */
  declaration(type: string) {
    return this.byType.get(type);
  }

  /** Whether browsers can be pushed to: WEB_PUSH_SUBJECT is set. */
  get pushEnabled() {
    return this.config.webPush !== undefined;
  }

  /** The channels this recipient may set: users, email and (when on) push; API clients none. */
  settable(recipient: Pick<Principal, 'kind'>): ChannelName[] {
    if (recipient.kind !== 'user') return [];
    return this.pushEnabled ? ['email', 'push'] : ['email'];
  }

  /** The settings of a type that apply to this recipient, by channel. */
  effective(
    declaration: NotificationTypeDeclaration<any>,
    overrides: Record<string, unknown> | undefined,
    recipient: Pick<Principal, 'kind'>,
  ) {
    return effectiveSettings(declaration, overrides, this.settable(recipient));
  }

  /** The schema of this recipient's `PUT /notifications/preferences`. */
  preferencesSchema(recipient: Pick<Principal, 'kind'>) {
    return preferencesSchema(this.declarations(), this.settable(recipient));
  }

  /**
   * A notification's texts in `locale` (the current request's when none),
   * from its type and data; `count` picks the plural form. A type that is
   * no longer declared shows as its name.
   */
  render(
    type: string,
    data: Record<string, unknown>,
    count: number,
    locale?: string,
  ): { title: string; body: string } {
    if (!this.byType.has(type)) {
      return { title: type, body: '' };
    }
    const args = { ...data, count };
    const key = `notifications.${type}`;
    return {
      title: this.i18n.translate(`${key}.title`, { locale, args }),
      body: this.i18n.translate(`${key}.body`, { locale, args }),
    };
  }

  /** What a type is called, for people, in `locale` (the current request's when none). */
  label(type: string, locale?: string) {
    return this.i18n.translate(`notifications.${type}.label`, { locale });
  }
}
