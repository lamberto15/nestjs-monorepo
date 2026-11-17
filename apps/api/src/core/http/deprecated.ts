import {
  applyDecorators,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UseInterceptors,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiOperation } from '@nestjs/swagger';
import type { NodeResponse as Response } from '@nestjs/platform-node';

/** What a deprecated route tells its callers. */
export type DeprecatedOptions = {
  /** When the route was deprecated (ISO date, `2026-10-21`): the `Deprecation` header's date (RFC 9745). */
  since: string;
  /** When it goes away (ISO date): the `Sunset` header (RFC 8594). */
  sunset?: string;
  /** A page that explains the deprecation and the way out: `Link: <url>; rel="deprecation"`. */
  link?: string;
  /** The route to move to: `Link: <url>; rel="successor-version"`. */
  successor?: string;
};

const DEPRECATED = 'api:deprecated';

/** RFC 9745: the date is a structured-field Date (`@` and Unix seconds), not `true`. */
export function deprecationHeader(since: string) {
  return `@${Math.floor(new Date(since).getTime() / 1000)}`;
}

/** RFC 8594: an HTTP-date. */
export function sunsetHeader(sunset: string) {
  return new Date(sunset).toUTCString();
}

/** The `Link` header value for the options' links, or undefined when there are none. */
export function deprecationLinks(options: DeprecatedOptions) {
  const links = [
    options.link && `<${options.link}>; rel="deprecation"`,
    options.successor && `<${options.successor}>; rel="successor-version"`,
  ].filter(Boolean);
  return links.length > 0 ? links.join(', ') : undefined;
}

/**
 * Marks a route (or a controller) as going away. Its responses carry
 * `Deprecation` (RFC 9745), `Sunset` (RFC 8594, when given) and `Link`
 * headers, the OpenAPI operation is `deprecated: true` (the typed client's
 * generated JSDoc then carries `@deprecated`).
 * Policy: docs/api-conventions.md, "Deprecation".
 */
export function Deprecated(options: DeprecatedOptions) {
  for (const date of [options.since, options.sunset]) {
    if (date !== undefined && Number.isNaN(new Date(date).getTime())) {
      throw new Error(`@Deprecated: "${date}" is not a date`);
    }
  }
  return applyDecorators(
    SetMetadata(DEPRECATED, options),
    ApiOperation({ deprecated: true }),
    UseInterceptors(DeprecationInterceptor),
  );
}

/**
 * Sets the headers; see `Deprecated()`. core/metrics counts the calls (`deprecated_route_calls_total`), by the `Deprecation` header.
 */
@Injectable()
export class DeprecationInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const options = this.reflector.getAllAndOverride<DeprecatedOptions>(
      DEPRECATED,
      [context.getHandler(), context.getClass()],
    );
    if (context.getType() === 'http' && options) {
      const res = context.switchToHttp().getResponse<Response>();
      res.setHeader('Deprecation', deprecationHeader(options.since));
      if (options.sunset) {
        res.setHeader('Sunset', sunsetHeader(options.sunset));
      }
      const links = deprecationLinks(options);
      if (links) {
        res.append('Link', links);
      }
    }
    return next.handle();
  }
}
