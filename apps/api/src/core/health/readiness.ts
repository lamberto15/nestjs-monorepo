import { DiscoveryService } from '@nestjs/core';

/**
 * Marks a provider as a readiness check of `GET /health`, under the given
 * name: the module that owns a dependency (the database, Redis) says how to
 * ask it, and the health controller finds the checks. The provider
 * implements `ReadinessIndicator`.
 */
export const ReadinessCheck = DiscoveryService.createDecorator<string>();

export interface ReadinessIndicator {
  /** Resolves when the dependency answers; throws when it doesn't. */
  check(): Promise<void>;
}
