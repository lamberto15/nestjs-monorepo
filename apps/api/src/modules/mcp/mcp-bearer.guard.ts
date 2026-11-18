import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SessionService } from '@nestjs/authentication';
import { t } from '@nestjs/i18n';

/** The refusal's code (the problem's `code`). */
export const MCP_BEARER_REQUIRED = 'mcp_bearer_required';

/**
 * The MCP endpoint takes an API key or a user token as a bearer, never the
 * session cookie: a browser sends the cookie on its own, so a page of
 * another site could act as the user (CSRF), and the endpoint answers every
 * call with one POST. A request that carries the session cookie is refused
 * (401 `mcp_bearer_required`), with or without a bearer, so the principal of
 * a call is always the bearer's.
 *
 * Custom: `@Authenticate({ providers })` on the route would leave the
 * route's result unshared, and every tool call would authenticate again,
 * outside HTTP (where an API client's address allowlist reads no address).
 * This guard keeps the one authentication of the HTTP request.
 */
@Injectable()
export class McpBearerGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    if (this.sessions.tokenFrom(request)) {
      throw new UnauthorizedException({
        code: MCP_BEARER_REQUIRED,
        message: t('mcp.bearerRequired'),
      });
    }
    return true;
  }
}
