import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ExecutionContext,
  Inject,
  Injectable,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DiscoveryService } from '@nestjs/core';
import {
  AuthenticationRegistry,
  SessionCookieProvider,
  type SessionRecord,
} from '@nestjs/authentication';
import { tenancyConfig } from '../../core/tenancy/tenancy.config.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { authConfig } from './auth.config.js';
import { discoverOne } from './discover.js';
import {
  HostTenantResolver,
  type HostTenants,
  hostOf,
  requestHostname,
} from './host-tenant.js';
import {
  type ImpersonationEligibility,
  ImpersonationRules,
  impersonationOf,
  sessionTenant,
} from './impersonation.js';
import type { RequestPrincipal } from './principal.js';
import { SessionLifetime } from './session-lifetime.js';
import { UsersRepository } from './users.repository.js';

/** Users, signed in with the session cookie. First in the chain (order 0). */
@Injectable()
export class SessionAuth
  extends SessionCookieProvider<RequestPrincipal>
  implements OnModuleInit
{
  /** The tenant of the request's host, while its session is validated. */
  private readonly hostTenant = new AsyncLocalStorage<string>();
  private hosts?: HostTenants;
  private impersonation?: ImpersonationEligibility;

  constructor(
    private readonly accounts: UsersRepository,
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
    @Inject(tenancyConfig.KEY)
    private readonly tenancyMode: ConfigType<typeof tenancyConfig>,
    private readonly tenancy: Tenancy,
    private readonly lifetime: SessionLifetime,
    private readonly discovery: DiscoveryService,
    registry: AuthenticationRegistry,
  ) {
    super();
    registry.registerProvider(this);
  }

  onModuleInit() {
    this.hosts = discoverOne<HostTenants>(
      this.discovery,
      HostTenantResolver,
      'host-to-tenant resolver (@HostTenantResolver())',
    );
    this.impersonation = discoverOne<ImpersonationEligibility>(
      this.discovery,
      ImpersonationRules,
      'impersonation rules (@ImpersonationRules())',
    );
  }

  // A tenant's custom domain is that tenant's only: on it, a session acts in
  // that tenant when its user is a member, else in none, whatever tenant it
  // was switched to. The cookie is host-only, so a session there was signed
  // in there; the host only ever narrows what a membership already allows.
  // With TENANCY=single every host is the one tenant's.
  override async authenticate(context: ExecutionContext) {
    const tenantId = await this.tenantOfHost(hostOf(context));
    return tenantId
      ? this.hostTenant.run(tenantId, () => super.authenticate(context))
      : super.authenticate(context);
  }

  /**
   * validate() of a stored session outside any request, as a request to
   * `host` (its `Host` header) would run it: the realtime socket it opened
   * asks again when the session's deadline passes. Reads, never touches it
   * (a socket is no activity); the package's own expiry is the caller's
   * (SessionLifetime.endsAt()).
   */
  async revalidate(
    session: SessionRecord,
    host: string | string[] | undefined,
  ) {
    const tenantId = await this.tenantOfHost(requestHostname(host));
    return tenantId
      ? this.hostTenant.run(tenantId, () => this.validate(session))
      : this.validate(session);
  }

  // Every request: a deactivated or deleted account loses access at once, a
  // membership that ended takes the session's tenant away, and an
  // impersonation ends when its time is up, when its administrator loses
  // access to the account or to the tenant it was started in, or when the
  // rule its start checked no longer holds (either person's roles changed).
  async validate(session: SessionRecord) {
    const pinned = this.hostTenant.getStore();
    const user = pinned
      ? ((await this.accounts.inTenant(session.userId, pinned)) ??
        (await this.accounts.inTenant(session.userId, null)))
      : await this.accounts.inTenant(session.userId, sessionTenant(session));
    const impersonation = impersonationOf(session);
    if (!user) {
      return user;
    }
    // The tenant's session limits under the environment's, which the
    // package applied already. Not for an impersonation: it has its own
    // time (below) and ends with the administrator's say.
    if (
      !impersonation &&
      (await this.lifetime.expired(session, user.tenantId))
    ) {
      return null;
    }
    if (!impersonation) {
      return user;
    }
    // IMPERSONATION=off ends the running ones too.
    if (!this.config.impersonation) {
      return null;
    }
    if (!(Date.now() < Date.parse(impersonation.endsAt))) {
      return null; // past its end, or an end that isn't a date
    }
    // Never across tenants: the impersonation lives in the tenant it began
    // in, while both are members of it.
    if (!user.tenantId || user.tenantId !== impersonation.tenantId) {
      return null;
    }
    const impersonator = await this.accounts.inTenant(
      impersonation.id,
      impersonation.tenantId,
    );
    if (impersonator?.tenantId !== impersonation.tenantId) {
      return null;
    }
    // The rule of its start, asked again in its tenant (the administrator's
    // abilities come from AccessService's cache); none without the module.
    const rules = this.impersonation;
    const eligible =
      !!rules &&
      (await this.tenancy.run(impersonation.tenantId, () =>
        rules.mayImpersonate(impersonator, user),
      ));
    return eligible
      ? {
          ...user,
          impersonator: { id: impersonator.id, email: impersonator.email },
        }
      : null;
  }

  private async tenantOfHost(host: string | undefined) {
    if (this.hosts) {
      return host ? this.hosts.tenantOfHost(host) : null;
    }
    return this.tenancyMode.mode === 'single'
      ? (await this.tenancy.soleTenant()).id
      : null;
  }
}
