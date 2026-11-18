import { DiscoveryService } from '@nestjs/core';

/**
 * Which units the tenant's identity provider manages over SCIM (its
 * groups), without importing the module that provisions them (iam/sso,
 * which imports organization): that module marks one provider
 * `@ScimUnits()`. Its units are the IdP's: an administrator's update,
 * delete or member change of one is a 409 `unit_managed_by_scim`. Without
 * one, no unit is.
 */
export interface ScimUnits {
  /** Those of these units the current tenant's IdP manages. */
  managedUnitIds(unitIds: readonly string[]): Promise<Set<string>>;
}

/** Marks the provider that implements ScimUnits (at most one). */
export const ScimUnits = DiscoveryService.createDecorator<void>();
