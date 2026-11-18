import { defineEvent } from '../../core/outbox/events.js';

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
   * Before an erase deletes the tenant's row (TenantsService.purge(): the
   * operator's deletion and the sign-up sweep), in the worker, outside any
   * tenant, in the erase's transaction: what of it lives outside its tables
   * goes (modules/storage releases its files, deleted after the commit). A
   * listener that must not be skipped declares
   * `@OnEvent(name, { suppressErrors: false })`: its error rolls the erase
   * back, and the next night tries again. Must be safe to run twice.
   */
  erasing: 'tenancy.tenant-erasing',
} as const;

export interface TenantDeactivatedEvent {
  tenantId: string;
}

export interface TenantErasingEvent {
  tenantId: string;
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
