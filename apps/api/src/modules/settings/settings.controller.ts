import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import { OperatorOnly } from '../../iam/auth/operator-only.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import {
  platformSettingSchema,
  type SetPlatformSettingDto,
  setPlatformSettingSchema,
  type SetSettingDto,
  setMineSchema,
  setSettingSchema,
  settingOverrideSchema,
  settingViewSchema,
  unsetSettingQuerySchema,
} from './settings.schemas.js';
import { SettingsPolicy } from './settings.policy.js';
import { SettingsService } from './settings.service.js';

const CONFLICT_GUARD =
  'A write a module refused because it would lock the caller out (409, the module names the `code`).';

/**
 * Settings and feature flags: what the modules declared, with the value
 * each caller gets. Reading is for anyone; setting a value for everyone, a
 * unit or a principal takes `Setting.update`; a user sets their own
 * preferences (settings scoped `user`) themselves.
 */
@ApiTags('settings')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @Can.Anyone()
  @ApiOperation({
    summary: 'Every setting and flag, with your value of each',
    description:
      "Your value: the operators' enforced value, else your own, else your unit's, else your tenant's (or a rollout), else the operators' value for every tenant, else the default. Settings not marked public show only to those who may read settings (Setting.read).",
  })
  @ApiOkResponse({ standardSchema: listSchema(settingViewSchema) })
  async list(@CurrentUser() user: RequestPrincipal) {
    return { items: await this.settings.effective(user) };
  }

  @Get(':key')
  @Can.Anyone()
  @ApiOperation({ summary: 'One setting, with your value' })
  @ApiOkResponse({ standardSchema: settingViewSchema })
  @ApiNotFoundResponse()
  async get(@CurrentUser() user: RequestPrincipal, @Param('key') key: string) {
    const declaration = this.settings.declaration(key);
    if (declaration.public === false && !(await this.settings.canRead(user))) {
      throw new NotFoundException(`No setting "${key}".`);
    }
    return this.settings.view(declaration, user);
  }

  @Put(':key/mine')
  @Can.Anyone()
  @ApiOperation({
    summary: 'Set your own value of a setting (a preference)',
    description: 'Only settings whose scopes include `user`. Audited.',
  })
  @ApiOkResponse({ standardSchema: settingViewSchema })
  @ApiBadRequestResponse({
    description: 'Not set per user, or an invalid value.',
  })
  @ApiNotFoundResponse()
  setMine(
    @CurrentUser() user: RequestPrincipal,
    @Param('key') key: string,
    @Body({ schema: setMineSchema }) body: z.infer<typeof setMineSchema>,
    @Ip() ip: string,
  ) {
    return this.settings.setMine(user, key, body.value, ip);
  }

  @Delete(':key/mine')
  @Can.Anyone()
  @ApiOperation({
    summary: 'Drop your own value of a setting: back to the shared one',
  })
  @ApiOkResponse({ standardSchema: settingViewSchema })
  @ApiNotFoundResponse()
  unsetMine(
    @CurrentUser() user: RequestPrincipal,
    @Param('key') key: string,
    @Ip() ip: string,
  ) {
    return this.settings.unsetMine(user, key, ip);
  }

  @Put(':key/platform')
  @AllowInMaintenance() // operators turn the mode off again
  @Can(SettingsPolicy, 'update')
  @OperatorOnly()
  @ApiOperation({
    summary: 'Set a setting for every tenant (operators)',
    description:
      "The runtime default of every tenant, below each tenant's own values; `enforced: true` puts it above them all (a kill switch). Operators only. Applies on the next request. Audited.",
  })
  @ApiOkResponse({ standardSchema: platformSettingSchema })
  @ApiBadRequestResponse({
    description:
      'A value its schema refuses (validation_failed), or one the deployment does not allow (setting_not_allowed).',
  })
  @ApiConflictResponse({ description: CONFLICT_GUARD })
  @ApiNotFoundResponse()
  setPlatform(
    @CurrentUser() user: RequestPrincipal,
    @Param('key') key: string,
    @Body({ schema: setPlatformSettingSchema }) body: SetPlatformSettingDto,
    @Ip() ip: string,
  ) {
    return this.settings.setPlatform(user, key, body, ip);
  }

  @Delete(':key/platform')
  @AllowInMaintenance() // operators turn the mode off again
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can(SettingsPolicy, 'update')
  @OperatorOnly()
  @ApiOperation({
    summary:
      "Remove the value for every tenant (operators): each tenant's own, or the default, holds again",
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async unsetPlatform(
    @CurrentUser() user: RequestPrincipal,
    @Param('key') key: string,
    @Ip() ip: string,
  ) {
    await this.settings.unsetPlatform(user, key, ip);
  }

  @Get(':key/overrides')
  @Can(SettingsPolicy, 'read')
  @ApiOperation({ summary: 'The stored values of a setting, every scope' })
  @ApiOkResponse({ standardSchema: listSchema(settingOverrideSchema) })
  @ApiNotFoundResponse()
  async overrides(@Param('key') key: string) {
    return { items: await this.settings.overrides(key) };
  }

  @Put(':key')
  @Can(SettingsPolicy, 'update')
  @ApiOperation({
    summary: 'Set a setting for everyone, a unit, or one principal',
    description:
      "Replaces what that scope had, in the caller's tenant. A flag at the tenant scope may take `rollout` (a percentage) instead of a value. Applies on the next request. Audited.",
  })
  @ApiOkResponse({ standardSchema: settingOverrideSchema })
  @ApiBadRequestResponse({
    description:
      'A scope the setting does not take, a value its schema refuses, a rollout on something that is not a flag at the tenant scope (validation_failed).',
  })
  @ApiConflictResponse({ description: CONFLICT_GUARD })
  @ApiNotFoundResponse({
    description: 'No such setting, unit or principal.',
  })
  set(
    @CurrentUser() user: RequestPrincipal,
    @Param('key') key: string,
    @Body({ schema: setSettingSchema }) body: SetSettingDto,
    @Ip() ip: string,
  ) {
    return this.settings.set(user, key, body, ip);
  }

  @Delete(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can(SettingsPolicy, 'update')
  @ApiOperation({
    summary: "Remove a scope's value: back to the next scope's, or the default",
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async unset(
    @CurrentUser() user: RequestPrincipal,
    @Param('key') key: string,
    @Query({ schema: unsetSettingQuerySchema })
    query: z.infer<typeof unsetSettingQuerySchema>,
    @Ip() ip: string,
  ) {
    await this.settings.unset(user, key, query.scope, query.scopeId, ip);
  }
}
