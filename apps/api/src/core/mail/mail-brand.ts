import { AsyncLocalStorage } from 'node:async_hooks';
import { DiscoveryService } from '@nestjs/core';

/**
 * What a tenant's mail looks like: the name it is sent under, the accent
 * colour (always `#rrggbb`: templates put it in a style attribute) and the
 * logo's absolute URL.
 */
export interface MailBrandData {
  /** The sender's display name; null: the deployment's own. */
  name: string | null;
  /** `#rrggbb`. */
  color: string;
  logoUrl: string | null;
}

/** What mail looks like when nothing brands it. */
export const DEFAULT_MAIL_BRAND: MailBrandData = {
  name: null,
  color: '#1f2328',
  logoUrl: null,
};

/**
 * The brand of the tenant in scope. Core can't import the module that keeps
 * it (modules/branding), so that module marks its provider `@MailBrand()`
 * and MailQueue finds it; with none, mail is unbranded.
 */
export interface MailBranding {
  /** The current tenant's brand, or null outside any tenant. */
  current(): Promise<MailBrandData | null>;
}

/** Marks the provider that answers for the tenant's brand (one per application). */
export const MailBrand = DiscoveryService.createDecorator();

const scope = new AsyncLocalStorage<MailBrandData>();

/** Renders with `brand` available to the layout and templates as `{{ brand.* }}`. */
export const withMailBrand = <T>(
  brand: MailBrandData,
  work: () => Promise<T>,
) => scope.run(brand, work);

/** The brand of the render in scope, else the default. */
export const currentMailBrand = () => scope.getStore() ?? DEFAULT_MAIL_BRAND;
