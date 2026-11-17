import type { ExecutionContext } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

/**
 * The tenant a request's host belongs to: a custom domain the tenant
 * verified. The module that keeps the domains (branding) marks its
 * provider with `@HostTenantResolver()`; SessionAuth finds it by discovery.
 * Without one every host is the app's own (with TENANCY=single: the one
 * tenant's).
 */
export interface HostTenants {
  /** The tenant whose verified domain `hostname` is, or null. */
  tenantOfHost(hostname: string): Promise<string | null>;
}

/** Marks the provider that implements HostTenants (at most one). */
export const HostTenantResolver = DiscoveryService.createDecorator<void>();

/**
 * The hostname a request was sent to, from its `Host` header (what the edge
 * passes on; never `X-Forwarded-Host`, which a client may set): lower case,
 * without the port and a trailing dot. Undefined when there is none.
 */
export function requestHostname(host: string | string[] | undefined) {
  const value = Array.isArray(host) ? host[0] : host;
  if (!value) {
    return undefined;
  }
  const name = value.startsWith('[')
    ? value.slice(0, value.indexOf(']') + 1)
    : value.replace(/:\d+$/, '');
  return name.toLowerCase().replace(/\.$/, '') || undefined;
}

/** The `Host` of an HTTP request or of a socket's handshake. */
export function hostOf(context: ExecutionContext) {
  switch (context.getType()) {
    case 'http':
      return requestHostname(
        context.switchToHttp().getRequest<{ headers: { host?: string } }>()
          .headers.host,
      );
    case 'ws':
      return requestHostname(
        context
          .switchToWs()
          .getClient<{ handshake?: { headers?: { host?: string } } }>()
          .handshake?.headers?.host,
      );
    default:
      return undefined;
  }
}
