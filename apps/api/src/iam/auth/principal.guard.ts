import {
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import {
  AuthenticationGuard,
  AuthenticationRegistry,
} from '@nestjs/authentication';
import { WsException } from '@nestjs/websockets';
import { ClsServiceManager } from 'nestjs-cls';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';

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
 *
 * Registered instead of the package's own global guard (`globalGuard:
 * false`), first of the app's guards after the rate limit: before
 * @nestjs/authorization's, which checks that at startup (it knows
 * subclasses by the guard's brand).
 */
@Injectable()
export class PrincipalGuard extends AuthenticationGuard {
  private readonly logger = new Logger('Authentication');

  constructor(
    reflector: Reflector,
    adapterHost: HttpAdapterHost,
    registry: AuthenticationRegistry,
    private readonly tenancy: Tenancy,
  ) {
    super(reflector, adapterHost, registry);
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
    if (user?.tenantId && ClsServiceManager.getClsService().isActive()) {
      this.tenancy.enter(user.tenantId);
    }
    return allowed;
  }
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
