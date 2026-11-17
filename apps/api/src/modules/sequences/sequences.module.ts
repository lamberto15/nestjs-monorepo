import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { NamingSeriesController } from './naming-series.controller.js';
import {
  NamingSeriesRegistry,
  type NamingVariable,
  type NumberedSubject,
  NumberingRegistration,
} from './naming-series.registry.js';
import { NamingSeriesService } from './naming-series.service.js';
import { sequencesConfig } from './sequences.config.js';
import { SEQUENCE_PERMISSIONS } from './sequences.permissions.js';
import { NamingSeriesPolicy } from './sequences.policy.js';
import { SequencesService } from './sequences.service.js';
import { NUMBERING_SETTINGS } from './sequences.settings.js';
import { SettingsModule } from '../settings/settings.module.js';

/**
 * Human-readable numbers (README.md): SequencesService (gapless counters
 * taken in the caller's transaction), NamingSeriesService (the formats a
 * tenant's administrators define per numbered subject) and the
 * `/naming-series` routes. A module that numbers records imports
 * `SequencesModule.forFeature({ subjects })`. Needs AuthModule (global),
 * DatabaseModule, TenancyModule and SettingsModule's needs.
 */
@Module({
  imports: [
    ConfigModule.forFeature(sequencesConfig),
    AccessModule.forFeature(SEQUENCE_PERMISSIONS),
    SettingsModule.forFeature(NUMBERING_SETTINGS),
    AuditModule,
    DiscoveryModule,
  ],
  controllers: [NamingSeriesController],
  providers: [
    SequencesService,
    NamingSeriesRegistry,
    NamingSeriesService,
    NamingSeriesPolicy,
  ],
  exports: [SequencesService, NamingSeriesService],
})
export class SequencesModule {
  /**
   * The numbered subjects (and the pattern variables) a module owns:
   * register them in the module that owns them. The registry finds every
   * registration at startup. Re-exports SequencesModule, so the module's
   * services inject `NamingSeriesService` and `SequencesService`.
   *
   * ```ts
   * SequencesModule.forFeature({
   *   subjects: [{ subject: 'Note', sequence: 'note', declared: { prefix: 'NOTE', perYear: true, width: 5 }, fields: { title: 'text' } }],
   * })
   * ```
   */
  static forFeature(registration: {
    subjects?: readonly NumberedSubject[];
    variables?: readonly NamingVariable[];
  }): DynamicModule {
    return {
      module: NumberingFeatureModule,
      imports: [SequencesModule],
      providers: [
        {
          provide: NumberingRegistration,
          useValue: new NumberingRegistration(
            registration.subjects ?? [],
            registration.variables ?? [],
          ),
        },
      ],
      exports: [SequencesModule],
    };
  }
}

/** The host of one `SequencesModule.forFeature()` registration. */
@Module({})
class NumberingFeatureModule {}
