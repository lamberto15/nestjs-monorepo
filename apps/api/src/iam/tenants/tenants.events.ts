import { defineEvent } from '../../core/outbox/events.js';
import type { Tenant } from '../../core/tenancy/tenancy.tables.js';
import type { UserPrincipal } from '../auth/principal.js';

/**
 * What a tenant's life tells the rest of the app inside the process
 * (@nestjs/event-emitter, `emitAsync()` and awaited). Defined here, not
 * imported by the listeners' modules from a registry: realtime listens by
 * name.
 */
export const TENANT_EVENTS = {
  /**
   * After the commit of a deactivation (an operator's `active: false`, or
   * a deletion's request): what outlives the database checks ends
   * (realtime closes the tenant's sockets). Sessions and token families in
   * it are ended here already.
   */
  deactivated: 'tenancy.tenant-deactivated',
  /**
   * Before the erase deletes the tenant's row, in the worker, outside any
   * tenant: what of it lives outside its tables goes (queued jobs, stored
   * files, workflows, outbox messages). A listener that must not be skipped
   * declares `@OnEvent(name, { suppressErrors: false })`: its error stops
   * the erase, and the next night tries again. Must be safe to run twice.
   */
  erasing: 'tenancy.tenant-erasing',
  /**
   * An operator made a tenant (`POST /v1/tenants`), in the transaction
   * that makes it, in the new tenant's scope: the invitations module
   * invites its first administrator and returns
   * `{ expiresAt: Date }`. Without a listener the create is refused (503
   * `invitations_unavailable`): a tenant nobody can enter is never made.
   */
  administratorInvited: 'tenancy.tenant-administrator-invited',
} as const;

export interface TenantDeactivatedEvent {
  tenantId: string;
}

export interface TenantErasingEvent {
  tenantId: string;
}

export interface TenantAdministratorInvitedEvent {
  tenant: Tenant;
  email: string;
  /** The operator who made the tenant. */
  actor: UserPrincipal;
}

/** What a listener of `administratorInvited` returns: when its link stops working. */
export interface AdministratorInvitation {
  expiresAt: Date;
}

/** Domain events (core/outbox), for subscribers in the worker (quotas, usage, webhooks). */
export const tenantCreated = defineEvent<{
  tenantId: string;
  slug: string;
  via: 'operator' | 'sign-up';
}>('tenant.created');
export const tenantDeactivated = defineEvent<{ tenantId: string }>(
  'tenant.deactivated',
);
export const tenantReactivated = defineEvent<{ tenantId: string }>(
  'tenant.reactivated',
);
export const tenantPurged = defineEvent<{
  tenantId: string;
  slug: string;
  reason: 'deletion' | 'sign-up-unverified';
}>('tenant.purged');
