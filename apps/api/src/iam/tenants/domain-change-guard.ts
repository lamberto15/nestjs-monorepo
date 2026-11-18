import { DiscoveryService } from '@nestjs/core';
import type { Principal } from '../auth/principal.js';

/**
 * What a module that can lock a tenant's domains (branding, when the
 * operators lock it) answers before one is added or checked: mark one
 * provider `@DomainChangeGuard()` and give it `assertEditable()`, which
 * throws (409 `branding_locked`) when the actor may not change the
 * tenant's domains. Without one, anyone who may manage domains can.
 */
export interface DomainChangeGuarded {
  assertEditable(actor: Principal): Promise<void>;
}

/** Marks the provider that implements DomainChangeGuarded (at most one). */
export const DomainChangeGuard = DiscoveryService.createDecorator<void>();
