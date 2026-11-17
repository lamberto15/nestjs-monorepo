import type { DiscoveryService } from '@nestjs/core';

/**
 * The one provider marked with `decorator` (DiscoveryService.createDecorator()),
 * or undefined when no module provides it. Two is a wiring mistake: startup
 * fails rather than pick one. Call it from `onModuleInit()`, once every
 * provider exists.
 */
export function discoverOne<T>(
  discovery: DiscoveryService,
  decorator: { KEY: string },
  what: string,
): T | undefined {
  const found = [
    ...new Set(
      discovery
        .getProviders({ metadataKey: decorator.KEY })
        .map((wrapper) => wrapper.instance as T)
        .filter((instance) => instance !== undefined && instance !== null),
    ),
  ];
  if (found.length > 1) {
    throw new Error(
      `${found.length} providers are marked as the ${what}: keep one.`,
    );
  }
  return found[0];
}
