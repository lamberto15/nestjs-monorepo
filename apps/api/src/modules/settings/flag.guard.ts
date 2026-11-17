import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiNotFoundResponse } from '@nestjs/swagger';
import type { Principal } from '../../iam/auth/principal.js';
import { SettingsService } from './settings.service.js';
import type { SettingDeclaration } from './settings.types.js';

/** The flag a route or controller needs (Nest's `Reflector.createDecorator`). */
const REQUIRED_FLAG = Reflector.createDecorator<SettingDeclaration<boolean>>();

/**
 * Answers 404 while the route's flag is off for the caller, as if the route
 * did not exist. A route guard, so it runs after the global ones: the
 * caller is authenticated and authorized, and their tenant is known.
 */
@Injectable()
export class FlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly settings: SettingsService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const flag = this.reflector.getAllAndOverride(REQUIRED_FLAG, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!flag) return true;
    const principal =
      context.switchToHttp().getRequest<{ user?: Principal | null }>().user ??
      null;
    if (!(await this.settings.enabled(flag, principal))) {
      throw new NotFoundException();
    }
    return true;
  }
}

/**
 * A route (or every route of a controller) that exists only while the flag
 * is on for the caller; off, it is a 404. The module of the route imports
 * `SettingsModule.forFeature()` (it provides the guard).
 *
 * ```ts
 * @Get('beta')
 * @Can.Anyone()
 * @RequireFlag(NOTE_BETA)
 * beta() { ... }
 * ```
 */
export const RequireFlag = (flag: SettingDeclaration<boolean>) =>
  applyDecorators(
    REQUIRED_FLAG(flag),
    UseGuards(FlagGuard),
    ApiNotFoundResponse({
      description: `Also while the \`${flag.key}\` flag is off for you.`,
    }),
  );
