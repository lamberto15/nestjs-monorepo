import { SetMetadata } from '@nestjs/common';

/** The metadata key of AllowInMaintenance(). */
export const ALLOW_IN_MAINTENANCE = Symbol('allow-in-maintenance');

/**
 * Marks a route that keeps answering while the deployment is read-only or in
 * maintenance (modules/mode): health, signing in, the operators' routes.
 * Lives here, below the mode module, so the platform-value routes can carry
 * it; the sign-in routes of iam need it in core (see the integration notes).
 */
export const AllowInMaintenance = () => SetMetadata(ALLOW_IN_MAINTENANCE, true);
