import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { t } from '@nestjs/i18n';
import type { RequestPrincipal } from '../auth/principal.js';
import {
  BREAK_GLASS_HEADER,
  BreakGlassService,
} from './break-glass.service.js';

/** The methods a break-glass request may use: reading only. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A request naming a grant (`Break-Glass: <grant id>`) is checked here,
 * on every request, and fails closed. A global guard: a request with the
 * header is never served as if it had none.
 *
 * - No signed-in user (this guard ran before authentication, or a guest),
 *   or a grant that isn't open and the caller's: 403 `break_glass_invalid`
 *   (or `break_glass_expired`).
 * - Anything but a read: 403 `break_glass_read_only`.
 * - A valid read: 403 `break_glass_unavailable` for now. Serving it needs
 *   what core/tenancy and iam/access don't offer yet: a read-only tenant
 *   scope (the binding's `set transaction read only`, so PostgreSQL
 *   refuses any write) entered in place of the operator's, and an ability
 *   of the catalog's read actions for the principal (see README.md). Until
 *   then the grant opens, is told and audited, and reads nothing.
 *
 * HTTP only: a socket never breaks glass.
 */
@Injectable()
export class BreakGlassGuard implements CanActivate {
  private readonly logger = new Logger('BreakGlass');

  constructor(private readonly breakGlass: BreakGlassService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const request = context.switchToHttp().getRequest<{
      method: string;
      originalUrl?: string;
      headers: Record<string, string | string[] | undefined>;
      user?: RequestPrincipal | null;
    }>();
    const header = request.headers[BREAK_GLASS_HEADER];
    if (header === undefined) {
      return true;
    }
    const user = request.user;
    const grantId = Array.isArray(header) ? header[0] : header;
    if (user?.kind !== 'user' || !grantId) {
      throw new ForbiddenException({
        code: 'break_glass_invalid',
        message: t('breakGlass.invalid'),
      });
    }
    const { tenantId } = await this.breakGlass.resolve(user, grantId);
    if (!SAFE.has(request.method.toUpperCase())) {
      throw new ForbiddenException({
        code: 'break_glass_read_only',
        message: t('breakGlass.readOnly'),
      });
    }
    this.logger.warn(
      `${user.email} asked to read tenant ${tenantId} (grant ${grantId}): refused, no read-only tenant scope in this build.`,
    );
    throw new ForbiddenException({
      code: 'break_glass_unavailable',
      message: t('breakGlass.unavailable'),
    });
  }
}
