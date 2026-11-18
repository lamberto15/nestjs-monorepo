import { DiscoveryService } from '@nestjs/core';
import type { UserPrincipal } from './principal.js';

/** The request header that names the break-glass grant a request reads through. */
export const BREAK_GLASS_HEADER = 'break-glass';

/** What a grant is checked against: the request through it. */
export interface BreakGlassRequest {
  method: string;
  path: string;
  ip?: string;
}

/**
 * Break-glass grants as sign-in uses them, without auth importing the
 * module that keeps them (iam/break-glass, which imports auth): that module
 * marks one provider `@BreakGlassGrantSource()`. PrincipalGuard asks it,
 * in the operator's own tenant, when a request names a grant
 * (`Break-Glass: <grant id>`), then runs the rest of the request in the
 * grant's tenant, read only. Without one, a request naming a grant is
 * refused (403 `break_glass_invalid`).
 */
export interface BreakGlassGrants {
  /**
   * The tenant `grantId` lets `user` read with this request, checked now;
   * throws a 403 when it doesn't (not theirs, ended, expired, not a read).
   */
  open(
    user: UserPrincipal,
    grantId: string,
    request: BreakGlassRequest,
  ): Promise<{ tenantId: string; expiresAt: Date }>;
}

/** Marks the provider that implements BreakGlassGrants (at most one). */
export const BreakGlassGrantSource = DiscoveryService.createDecorator<void>();
