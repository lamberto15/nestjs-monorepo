import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { ConfigService, type ConfigType } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import type { tenancyConfig } from '../../core/tenancy/tenancy.config.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import type { authConfig } from './auth.config.js';
import type { Principal } from './principal.js';

/**
 * The deployment's operators only: a route that sees past one tenant (the
 * queues of every tenant, the tenants themselves) answers only a principal
 * acting in the operators' tenant (OPERATOR_TENANT, or the one tenant with
 * TENANCY=single), and active, on top of its permission; anyone else gets
 * 403 `operator_required`, whatever their roles in their own tenant.
 * OPERATOR_TENANT unset in a multi-tenant deployment: nobody.
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(
    private readonly tenancy: Tenancy,
    // ConfigService, not the config keys: the guard is built in the module
    // of the route that uses it, where only global providers are sure to be.
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const principal = context
      .switchToHttp()
      .getRequest<{ user?: Principal | null }>().user;
    if (!(await this.actsAsOperator(principal ?? null))) {
      throw new ForbiddenException({
        code: 'operator_required',
        message: t('auth.operatorRequired'),
      });
    }
    return true;
  }

  /** Whether the principal acts in the operators' tenant, an active one. */
  async actsAsOperator(principal: Principal | null): Promise<boolean> {
    const tenantId =
      principal && principal.kind !== 'system' ? principal.tenantId : null;
    const tenant = tenantId ? await this.tenancy.find(tenantId) : undefined;
    if (!tenant?.active) {
      return false;
    }
    const mode =
      this.config.getOrThrow<ConfigType<typeof tenancyConfig>>('tenancy').mode;
    if (mode === 'single') {
      return tenant.id === (await this.tenancy.soleTenant()).id;
    }
    return isOperatorSlug(
      this.config.getOrThrow<ConfigType<typeof authConfig>>('auth'),
      tenant.slug,
    );
  }
}

/**
 * Whether `slug` names the operators' tenant (OPERATOR_TENANT) of a
 * multi-tenant deployment; unset, no slug does. The one statement of that
 * rule: the guard above, the tenants list and switch, and the tenants
 * module, which never lets that tenant's slug change nor another take it.
 */
export const isOperatorSlug = (
  auth: Pick<ConfigType<typeof authConfig>, 'operatorTenant'>,
  slug: string,
) => auth.operatorTenant !== undefined && slug === auth.operatorTenant;

/** Marks a controller or route as the operators' (OperatorGuard). */
export const OperatorOnly = () =>
  applyDecorators(
    UseGuards(OperatorGuard),
    ApiForbiddenResponse({
      description:
        "operator_required: the caller does not act in the operators' tenant.",
    }),
  );
