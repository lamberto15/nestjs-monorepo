import { Injectable } from '@nestjs/common';
import { MfaService } from '@nestjs/authentication';
import type { Principal } from '../auth/principal.js';
import { AccountStores } from './account.stores.js';
import { AccountUsers } from './account.users.js';
import { PasswordHistoryService } from './password-history.service.js';
import {
  type PendingAlert,
  SecurityAlerts,
} from './security-alerts.service.js';

/**
 * What an operator does to an account (the `pnpm ops` commands, src/cli),
 * without the account module's services leaving it. Each method but
 * `tell()` runs in the caller's transaction, `system` being the actor of
 * the audit entry; the sessions and tokens of the account are ended by the
 * caller afterwards, then `tell()` mails its owner.
 */
@Injectable()
export class AccountOperations {
  constructor(
    private readonly users: AccountUsers,
    private readonly history: PasswordHistoryService,
    private readonly alerts: SecurityAlerts,
    private readonly stores: AccountStores,
    private readonly mfa: MfaService,
  ) {}

  /** Sets a hashed password as the API's change does (history kept, owner alerted). */
  async replacePassword(
    system: Principal,
    userId: string,
    passwordHash: string,
    details: Record<string, unknown>,
  ) {
    await this.history.replaced(userId);
    await this.users.replacePassword(userId, passwordHash);
    return this.alerts.credentialsChanged(system, userId, {
      action: 'ops.password-reset',
      ip: '',
      alert: 'passwordChanged',
      details,
    });
  }

  /** Removes the authenticator and recovery codes and the lockout. */
  async removeMfa(
    system: Principal,
    userId: string,
    details: Record<string, unknown>,
  ) {
    await this.mfa.disable(userId);
    await this.stores.clearMfaFailures(userId);
    return this.alerts.credentialsChanged(system, userId, {
      action: 'ops.mfa-removed',
      ip: '',
      alert: 'mfaDisabled',
      details,
    });
  }

  /** The failed second-factor attempts of the last 24 hours. */
  mfaFailures(userId: string) {
    return this.stores.countMfaFailures(userId, 24 * 3_600_000, Date.now());
  }

  /** Clears the failed second-factor attempts (the lockout). */
  clearMfaFailures(userId: string) {
    return this.stores.clearMfaFailures(userId);
  }

  /** After the commit: mails the owner (a failure is logged, never thrown). */
  tell(alert: PendingAlert | null) {
    return this.alerts.tell(alert);
  }
}
