import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import {
  AUTH_EVENTS,
  type ClientIpDeniedEvent,
  type SignedInEvent,
  type SignInFailedEvent,
} from '../auth/auth.events.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import { AuditService } from './audit.service.js';
import { SIGN_IN_ACTIONS } from './sign-in-actions.js';

/**
 * What auth announces, in the audit log. `suppressErrors: false`: an entry
 * that can't be written fails the request that announced it (a sign-in
 * isn't left unrecorded). Two entries per sign-in: the account's own
 * (`auth.signed-in`, `auth.sign-in-failed`), in no tenant, which no
 * tenant's administrator reads; and the tenant's (`member.*`), in the
 * tenant the sign-in lands in, all that tenant ever reads of it.
 */
@Injectable()
export class AuditListeners implements OnApplicationShutdown {
  private readonly logger = new Logger('Audit');
  /** Tenants' entries of failed sign-ins being written (see signInFailed). */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly audit: AuditService,
    private readonly tenancy: Tenancy,
    private readonly users: UsersRepository,
  ) {}

  @OnEvent(AUTH_EVENTS.signedIn, { suppressErrors: false })
  async signedIn(event: SignedInEvent) {
    await this.tenancy.run(null, () =>
      this.audit.record(event.user, {
        action: 'auth.signed-in',
        ip: event.ip,
        details: {
          method: event.method,
          ...(event.userAgent && { userAgent: event.userAgent }),
        },
      }),
    );
    if (event.tenantId) {
      await this.memberEntry(
        event.user,
        SIGN_IN_ACTIONS.succeeded,
        event.tenantId,
        event,
      );
    }
  }

  /**
   * The account-level entry is written before the answer; the tenant's is
   * not waited for: an unknown address has nobody's log to write, and both
   * answers must take the same time. Its failure is logged only.
   */
  @OnEvent(AUTH_EVENTS.signInFailed, { suppressErrors: false })
  async signInFailed(event: SignInFailedEvent) {
    await this.tenancy.run(null, () =>
      this.audit.recordAnonymous(event.email, {
        action: 'auth.sign-in-failed',
        ip: event.ip,
        details: { method: event.method },
      }),
    );
    const user = event.user;
    if (!user) {
      return;
    }
    const work = this.users
      .defaultTenant(user.id)
      .then((tenantId) =>
        tenantId
          ? this.memberEntry(user, SIGN_IN_ACTIONS.failed, tenantId, event)
          : undefined,
      )
      .catch((error: unknown) =>
        this.logger.warn(`A failed sign-in was not logged: ${String(error)}`),
      )
      .finally(() => this.inFlight.delete(work));
    this.inFlight.add(work);
  }

  @OnEvent(AUTH_EVENTS.clientIpDenied, { suppressErrors: false })
  async clientIpDenied({ client, ip }: ClientIpDeniedEvent) {
    await this.tenancy.run(client.tenantId, () =>
      this.audit.record(client, {
        action: 'client.ip-denied',
        targetType: 'client',
        targetId: client.id,
        details: { name: client.name },
        ip,
      }),
    );
  }

  /** The writes of failed sign-ins, once done (tests, shutdown). */
  async settled() {
    await Promise.allSettled(this.inFlight);
  }

  async onApplicationShutdown() {
    await this.settled();
  }

  private memberEntry(
    user: UserPrincipal,
    action: string,
    tenantId: string,
    event: { method: string; ip: string },
  ) {
    return this.tenancy.run(tenantId, () =>
      this.audit.record(user, {
        action,
        targetType: 'user',
        targetId: user.id,
        ip: event.ip || undefined,
        details: { method: event.method },
      }),
    );
  }
}
