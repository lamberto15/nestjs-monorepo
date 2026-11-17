import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { AuthorizationModule } from '@nestjs/authorization';
import { AuditModule } from '../audit/audit.module.js';
import { accessConfig } from './access.config.js';
import { AccessController } from './access.controller.js';
import { ACCESS_PERMISSIONS } from './access.permissions.js';
import { AccessPolicy } from './access.policy.js';
import { AccessSeeder } from './access.seeder.js';
import { AccessService } from './access.service.js';
import { ExplanationService } from './explanation.service.js';
import { MembersService } from './members.service.js';
import {
  PermissionCatalog,
  PermissionsRegistration,
} from './permission-catalog.js';
import type { PermissionsDefinition } from './permissions.js';
import { PrincipalsService } from './principals.service.js';
import { RolesService } from './roles.service.js';
import { SystemContext } from './system-context.js';

/**
 * Who may do what (README.md): the permission catalog every module adds
 * to (`AccessModule.forFeature()`), AccessService (the one place CASL
 * runs), roles and their grants, the access API, the first-boot seed and
 * the system principal (SystemContext). Registers @nestjs/authorization
 * (its global guard denies a route that declares no check), so it comes
 * after AuthModule. Needs AuthModule (global), AuditModule's tables,
 * DatabaseModule, TenancyModule, RedisModule, I18nModule and
 * EventEmitterModule.forRoot().
 */
@Module({
  imports: [
    AuthorizationModule.forRoot(),
    DiscoveryModule,
    AuditModule,
    ConfigModule.forFeature(accessConfig),
  ],
  controllers: [AccessController],
  providers: [
    PermissionCatalog,
    AccessService,
    AccessPolicy,
    RolesService,
    MembersService,
    PrincipalsService,
    ExplanationService,
    SystemContext,
    AccessSeeder,
    {
      provide: PermissionsRegistration,
      useValue: new PermissionsRegistration(ACCESS_PERMISSIONS),
    },
  ],
  exports: [
    PermissionCatalog,
    AccessService,
    AccessPolicy,
    RolesService,
    MembersService,
    SystemContext,
  ],
})
export class AccessModule {
  /**
   * A module's permissions: its subjects (actions, conditions, fields),
   * what API clients may do, its grants to the seed roles and its system
   * jobs. Import it in the module that owns them; the catalog finds every
   * registration at startup and refuses an inconsistent one. Re-exports
   * AccessModule, so the module's services and policies inject
   * AccessService and SystemContext.
   *
   * ```ts
   * @Module({ imports: [AccessModule.forFeature(NOTE_PERMISSIONS)], … })
   * ```
   */
  static forFeature(definition: PermissionsDefinition): DynamicModule {
    return {
      module: AccessFeatureModule,
      imports: [AccessModule],
      providers: [
        {
          provide: PermissionsRegistration,
          useValue: new PermissionsRegistration(definition),
        },
      ],
      exports: [AccessModule],
    };
  }
}

/** The host of one `AccessModule.forFeature()` registration. */
@Module({})
class AccessFeatureModule {}
