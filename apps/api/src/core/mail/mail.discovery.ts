import type { DiscoveryService } from '@nestjs/core';

/**
 * The provider a module marked with one of core/mail's discovery decorators
 * (`@MailSuppressionList()`, `@MailDeliveryPolicy()`, `@MailBrand()`), or
 * undefined when no module in the application provides it.
 */
export const markedProvider = <T>(
  discovery: DiscoveryService,
  decorator: { KEY: string },
): T | undefined =>
  discovery.getProviders({ metadataKey: decorator.KEY }).at(0)?.instance as
    T | undefined;
