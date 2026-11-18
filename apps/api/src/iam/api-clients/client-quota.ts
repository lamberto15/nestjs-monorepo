import { DiscoveryService } from '@nestjs/core';
import type { UserPrincipal } from '../auth/principal.js';

/**
 * A new client's daily quota, set in its create's transaction, without
 * importing the module that keeps quotas (modules/usage): that module marks
 * one provider `@ClientQuota()`. Without one, a create naming `dailyQuota`
 * is refused (400).
 */
export interface ClientQuota {
  /** Whether `actor` may set a client's quota (checked before anything is written). */
  allowed(actor: UserPrincipal): Promise<boolean>;
  /** Sets it, in the current transaction; audited. */
  set(
    actor: UserPrincipal,
    clientId: string,
    dailyQuota: number,
    ip?: string,
  ): Promise<unknown>;
}

/** Marks the provider that implements ClientQuota (at most one). */
export const ClientQuota = DiscoveryService.createDecorator<void>();
