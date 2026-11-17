import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { t } from '@nestjs/i18n';
import { ApiNotFoundResponse } from '@nestjs/swagger';

interface Switch {
  /** Where the switch is read: `<config namespace>.<key>` (`auth.apiClients`). */
  path: string;
  /** The environment variable, for the message (`API_CLIENTS`). */
  variable: string;
}

const SWITCH = Symbol('deployment-switch');

/**
 * Refuses the route with 404 `feature_off` unless its switch is on: the
 * route doesn't exist for this deployment. Read on every request (a test
 * may turn it off while the app runs); anything but `true` (a typo in the
 * path, a missing namespace) counts as off. It runs after the global
 * guards, so a caller that isn't signed in still gets 401 and learns
 * nothing about the deployment.
 */
@Injectable()
export class DeploymentSwitchGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext) {
    const found = this.reflector.getAllAndOverride<Switch | undefined>(SWITCH, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (found && this.config.get<unknown>(found.path) !== true) {
      throw new NotFoundException({
        code: 'feature_off',
        message: t('auth.featureOff', { args: { name: found.variable } }),
      });
    }
    return true;
  }
}

/**
 * The route exists only while the switch is on (DeploymentSwitchGuard):
 * `@RequiresSwitch('auth.apiClients', 'API_CLIENTS')`. The switch is a
 * `flag()` of a module's `*.config.ts`, whose module imports
 * `ConfigModule.forFeature()` of it.
 */
export const RequiresSwitch = (path: string, variable: string) =>
  applyDecorators(
    SetMetadata(SWITCH, { path, variable } satisfies Switch),
    UseGuards(DeploymentSwitchGuard),
    ApiNotFoundResponse({
      description: `feature_off: ${variable}=off in this deployment.`,
    }),
  );
