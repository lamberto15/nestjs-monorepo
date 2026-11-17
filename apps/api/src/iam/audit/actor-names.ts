import { DiscoveryService } from '@nestjs/core';

/**
 * How the audit log names its actors now, without importing the module
 * that knows them (people, API clients): that module marks a provider with
 * `@ActorNameSource()`. Absent, entries carry no name (`actorName: null`).
 */
export interface ActorNames {
  /**
   * The names of these principal keys (`user:<id>`, `client:<id>`) in the
   * current tenant, in one round whatever their number; null for a key
   * with none (`anonymous`, `system:<key>`, a deleted account, a removed
   * client).
   */
  names(keys: Iterable<string>): Promise<Map<string, string | null>>;
}

/** Marks the provider that implements ActorNames (at most one). */
export const ActorNameSource = DiscoveryService.createDecorator<void>();
