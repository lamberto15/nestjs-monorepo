import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MailQueue } from '../../core/mail/mail.queue.js';
import { Events } from '../../core/outbox/events.js';
import { AuditService } from '../audit/audit.service.js';
import { AUTH_EVENTS, type SignedInEvent } from '../auth/auth.events.js';
import type { Principal } from '../auth/principal.js';
import { securityAlerted } from './account.events.js';
import { SecurityAlertMail, type SecurityAlertKind } from './account.mails.js';
import { AccountWork } from './account-work.js';
import { AccountRepository } from './account.repository.js';
import { deviceOf, normalizeIp } from './devices.js';

/** A device unseen for this long is new again. */
const KNOWN_DEVICE_DAYS = 30;

/** A change to an account's credentials, as audited and told to its owner. */
export interface CredentialChange {
  /** The audit action (`auth.password-changed`). */
  action: string;
  ip: string;
  /** The mail that tells the owner. */
  alert: SecurityAlertKind;
  /** The mail's arguments besides `ip` (the passkey's `name`). */
  args?: Record<string, string>;
  /** The audit entry's details (which passkey). */
  details?: Record<string, unknown>;
  /** Tell the owner only if the account signed in before (an invitation's first password isn't news). */
  onlyIfUsed?: boolean;
}

/** What to mail once the change committed: `SecurityAlerts.tell()`. */
export interface PendingAlert {
  userId: string;
  kind: SecurityAlertKind;
  args: Record<string, string>;
}

/**
 * Tells a person about changes to their account's security, by mail
 * (SecurityAlertMail, essential): a new sign-in, a password changed or
 * found in a breach, two-factor on or off, a passkey added or removed.
 *
 * A change's audit entry is written in the change's transaction
 * (`credentialsChanged()`, inside it), and its mail is queued after the
 * commit (`tell()`), so nobody hears of a change that rolled back.
 * Addresses are recorded as people know them (`normalizeIp`).
 *
 * Sign-ins: every one is announced (`auth.signed-in`, which iam/audit
 * records); this listens, keeps the account's devices (`account_devices`)
 * and mails the owner when the device is new: the account signed in
 * before, but not from this device (user agent without versions + IPv4
 * address or IPv6 /64, see `deviceOf`) in the last 30 days.
 *
 * Every alert is also published (`account.security-alerted`, in the
 * change's transaction) for the modules that keep a record of it (the
 * in-app notice of modules/notifications); the mail is sent here only.
 * Without the outbox (a test that doesn't boot it), nothing is published.
 */
@Injectable()
export class SecurityAlerts {
  private readonly logger = new Logger(SecurityAlerts.name);

  constructor(
    private readonly audit: AuditService,
    private readonly accounts: AccountRepository,
    private readonly mail: MailQueue,
    private readonly work: AccountWork,
    @Optional() private readonly events?: Events,
  ) {}

  /**
   * In the change's transaction: its audit entry (account-level, in no
   * tenant's log), and the owner's alert to send after the commit; null
   * when nobody is to be told.
   */
  async credentialsChanged(
    actor: Principal | null,
    userId: string,
    change: CredentialChange,
  ): Promise<PendingAlert | null> {
    const ip = normalizeIp(change.ip);
    const used = !change.onlyIfUsed || (await this.hasSignedIn(userId));
    await this.audit.record(actor, {
      action: change.action,
      targetType: 'user',
      targetId: userId,
      ...(change.details && { details: change.details }),
      ip,
    });
    if (!used) {
      return null;
    }
    const alert = { userId, kind: change.alert, args: { ...change.args, ip } };
    // The tenant the owner acts in, when they made the change themselves.
    const tenantId =
      actor?.kind === 'user' && actor.id === userId ? actor.tenantId : null;
    await this.publish(alert, tenantId);
    return alert;
  }

  /** In the change's transaction: the alert as a domain event. */
  private async publish(alert: PendingAlert, tenantId: string | null) {
    await this.events?.publish(
      securityAlerted,
      { ...alert, tenantId, at: new Date().toISOString() },
      { key: alert.userId },
    );
  }

  /**
   * After the commit: queues the alert's mail. Its failure is logged, never
   * the change's: the change is done and audited.
   */
  async tell(alert: PendingAlert | null) {
    if (!alert) {
      return;
    }
    try {
      const user = await this.accounts.find(alert.userId);
      if (!user?.active) {
        return;
      }
      await this.mail.send(SecurityAlertMail, {
        to: { name: user.name, address: user.email },
        data: { kind: alert.kind, name: user.name, args: alert.args },
        locale: user.locale ?? undefined,
      });
    } catch (error) {
      this.logger.error(`A security alert was not sent: ${String(error)}`);
    }
  }

  /**
   * A sign-in, by any method: the device is remembered, and the owner told
   * when it's new. Never fails the sign-in: logged instead.
   */
  @OnEvent(AUTH_EVENTS.signedIn)
  async signedIn(event: SignedInEvent) {
    try {
      // The account's own rows, in no tenant (the sign-in may land in one).
      const alert = await this.work.run(async () => {
        const found = await this.rememberDevice(event);
        if (found) {
          await this.publish(found, event.tenantId);
        }
        return found;
      });
      await this.tell(alert);
    } catch (error) {
      this.logger.error(
        `A sign-in's device was not recorded: ${String(error)}`,
      );
    }
  }

  private async rememberDevice({
    user,
    ip,
    userAgent,
  }: SignedInEvent): Promise<PendingAlert | null> {
    const device = deviceOf(userAgent, ip);
    const since = new Date(Date.now() - KNOWN_DEVICE_DAYS * 86_400_000);
    const seen = await this.accounts.seenDevice(user.id, device.hash, since);
    const other =
      !seen && (await this.accounts.hasOtherDevice(user.id, device.hash));
    await this.accounts.touchDevice(user.id, device.hash, new Date());
    // The first sign-in ever, or a known device: nothing to tell.
    return seen || !other
      ? null
      : {
          userId: user.id,
          kind: 'newSignIn',
          args: { device: device.summary, ip: device.ip },
        };
  }

  /** Whether the account ever signed in (a device of it is known). */
  private hasSignedIn(userId: string) {
    return this.accounts.hasDevice(userId);
  }
}
