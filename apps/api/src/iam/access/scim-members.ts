import { DiscoveryService } from '@nestjs/core';

/**
 * Which members the tenant's identity provider manages over SCIM, without
 * importing the module that provisions them (iam/sso, which imports
 * access): that module marks one provider `@ScimMembers()`. Without one,
 * nobody is (`managedByScim: false`).
 */
export interface ScimMembers {
  /** Those of these users the current tenant's IdP provisioned. */
  managedUserIds(userIds: readonly string[]): Promise<Set<string>>;
}

/** Marks the provider that implements ScimMembers (at most one). */
export const ScimMembers = DiscoveryService.createDecorator<void>();
