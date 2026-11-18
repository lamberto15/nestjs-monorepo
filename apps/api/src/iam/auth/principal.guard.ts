import {
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  type OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { DiscoveryService, HttpAdapterHost, Reflector } from '@nestjs/core';
import { t } from '@nestjs/i18n';
import {
  AuthenticationGuard,
  AuthenticationRegistry,
} from '@nestjs/authentication';
import { WsException } from '@nestjs/websockets';
import { ClsServiceManager } from 'nestjs-cls';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import {
  BREAK_GLASS_HEADER,
  BreakGlassGrantSource,
  type BreakGlassGrants,
} from './break-glass-session.js';
import { discoverOne } from './discover.js';
import type { UserPrincipal } from './principal.js';

/** The refusal's code (Nest's `errorCode`, the problem's `code`). */
export const SYSTEM_PRINCIPAL_REFUSED = 'system_principal_refused';

/**
 * @nestjs/authentication's guard (every route needs a principal unless
 * `@Public()`), and two rules on top:
 *
 * - whatever a credential provider returns, the system principal never acts
 *   for a request or a socket message (401 `system_principal_refused`): the
 *   line a future provider can't cross by mistake;
 * - the request enters its principal's tenant (`Tenancy.enter()`) before
 *   anything after this guard queries. A guest, or a user without a tenant,
 *   enters none: tenant tables are out of reach.
 * - an HTTP request naming a break-glass grant (`Break-Glass: <id>`) is
 *   checked by the grants' source (break-glass-session.ts) in the
 *   operator's own tenant, and enters the grant's tenant read only instead,
 *   the principal saying so (`breakGlass`). It fails closed: no signed-in
 *   user, no source, or a grant the source refuses is a 403, never a
 *   request served as if it had no header.
 *
 * Registered instead of the package's own global guard (`globalGuard:
 * false`), first of the app's guards after the rate limit: before
 * @nestjs/authorization's, which checks that at startup (it knows
 * subclasses by the guard's brand).
 */
@Injectable()
export class PrincipalGuard
  extends AuthenticationGuard
  implements OnModuleInit
{
  private readonly logger = new Logger('Authentication');
  private grants?: BreakGlassGrants;

  constructor(
    reflector: Reflector,
    adapterHost: HttpAdapterHost,
    registry: AuthenticationRegistry,
    private readonly tenancy: Tenancy,
    private readonly discovery: DiscoveryService,
  ) {
    super(reflector, adapterHost, registry);
  }

  onModuleInit() {
    this.grants = discoverOne<BreakGlassGrants>(
      this.discovery,
      BreakGlassGrantSource,
      'break-glass grants (@BreakGlassGrantSource())',
    );
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = await super.canActivate(context);
    const carrier = carrierOf(context);
    const user = carrier?.user as
      { kind?: string; tenantId?: string | null } | null | undefined;
    if (user?.kind === 'system') {
      // As the package's own refusals do: a socket keeps no principal it was refused.
      carrier!.user = null;
      this.logger.error(
        'A credential provider returned the system principal: refused.',
      );
      const body = {
        statusCode: 401,
        message: 'The system principal cannot authenticate a request.',
        errorCode: SYSTEM_PRINCIPAL_REFUSED,
      };
      throw context.getType() === 'ws'
        ? new WsException({ status: 'error', ...body })
        : new UnauthorizedException({
            code: SYSTEM_PRINCIPAL_REFUSED,
            message: body.message,
          });
    }
    const grantId = breakGlassGrantOf(context);
    if (grantId !== undefined) {
      await this.enterThroughGrant(user, grantId, context);
      return allowed;
    }
    if (user?.tenantId && ClsServiceManager.getClsService().isActive()) {
      this.tenancy.enter(user.tenantId);
    }
    return allowed;
  }

  /**
   * The grant checked in the operator's own tenant, then the rest of the
   * request in the grant's tenant, read only. The principal is changed in
   * place: it is the object `@CurrentUser()` and the later guards read.
   */
  private async enterThroughGrant(
    user: { kind?: string; tenantId?: string | null } | null | undefined,
    grantId: string,
    context: ExecutionContext,
  ) {
    const operator = user?.kind === 'user' ? (user as UserPrincipal) : null;
    const operatorTenantId = operator?.tenantId;
    if (!this.grants || !operator || !operatorTenantId || operator.breakGlass) {
      throw new ForbiddenException({
        code: 'break_glass_invalid',
        message: t('auth.breakGlassInvalid'),
      });
    }
    const request = context.switchToHttp().getRequest<{
      method: string;
      originalUrl?: string;
      url?: string;
      ip?: string;
    }>();
    const grants = this.grants;
    const { tenantId, expiresAt } = await this.tenancy.run(
      operatorTenantId,
      () =>
        grants.open(operator, grantId, {
          method: request.method,
          path: request.originalUrl ?? request.url ?? '',
          ip: request.ip,
        }),
    );
    operator.breakGlass = {
      grantId,
      tenantId,
      operatorTenantId,
      expiresAt: expiresAt.toISOString(),
    };
    operator.tenantId = tenantId;
    this.tenancy.enter(tenantId, { readOnly: true });
  }
}

/** The grant an HTTP request names (`Break-Glass`), or undefined; a socket never breaks glass. */
function breakGlassGrantOf(context: ExecutionContext): string | undefined {
  if (context.getType() !== 'http') {
    return undefined;
  }
  const header = context
    .switchToHttp()
    .getRequest<{ headers: Record<string, string | string[] | undefined> }>()
    .headers[BREAK_GLASS_HEADER];
  return Array.isArray(header) ? (header[0] ?? '') : header;
}

/** Where the package mirrors the result as `user`: the request, or the socket. */
function carrierOf(context: ExecutionContext): { user?: unknown } | undefined {
  switch (context.getType()) {
    case 'http':
      return context.switchToHttp().getRequest();
    case 'ws':
      return context.switchToWs().getClient();
    default:
      return undefined;
  }
}
