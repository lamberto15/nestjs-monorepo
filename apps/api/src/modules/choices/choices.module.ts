import { type DynamicModule, Inject, Injectable, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import type { Principal } from '../../iam/auth/principal.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { OrganizationModule } from '../../iam/organization/organization.module.js';
import type { RecordDeclaration } from '../records/record.js';
import {
  InjectRecord,
  RECORD,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import { RecordsModule } from '../records/records.module.js';
import {
  OrganizationalUnitsChoices,
  UNIT_MEMBER_SET,
  UnitMembersChoices,
} from './choices.builtins.js';
import { ChoicesController } from './choices.controller.js';
import { ChoicesLoader } from './choices.loader.js';
import {
  ChoicesRegistry,
  type ChoiceSet,
  ChoiceSets,
} from './choices.registry.js';
import { ChoicesService } from './choices.service.js';

/** The set a record validates (`forRecord(record, set)`). */
const RECORD_SET = Symbol('RECORD_SET');

/**
 * Dependent dropdowns (README.md): the registry of providers and sets,
 * the `/v1/choices` routes and the check a write repeats
 * (`ChoicesService.assertValid()`). A module declares its providers
 * (`@ChoiceSource()`) and sets (`ChoicesModule.forFeature()`); a record
 * whose fields are a set's imports `ChoicesModule.forRecord()`.
 */
@Module({
  imports: [DiscoveryModule, AccessModule, OrganizationModule],
  controllers: [ChoicesController],
  providers: [
    ChoicesRegistry,
    ChoicesService,
    ChoicesLoader,
    OrganizationalUnitsChoices,
    UnitMembersChoices,
    { provide: ChoiceSets, useValue: new ChoiceSets([UNIT_MEMBER_SET]) },
  ],
  exports: [ChoicesService, ChoicesRegistry],
})
export class ChoicesModule {
  /**
   * The sets a module owns (its providers are `@ChoiceSource()` classes in
   * its own providers). Re-exports ChoicesModule, so its services inject
   * `ChoicesService`.
   */
  static forFeature(registration: {
    sets: readonly ChoiceSet[];
  }): DynamicModule {
    return {
      module: ChoiceSetsHost,
      imports: [ChoicesModule],
      providers: [
        { provide: ChoiceSets, useValue: new ChoiceSets(registration.sets) },
      ],
      exports: [ChoicesModule],
    };
  }

  /**
   * A record whose fields (by name) are the fields of `set`: a create, and
   * an update that touches one of them, are refused (400) unless every
   * value is a choice the writer could pick for its parents' values, those
   * stored with the record included. Registers the set.
   */
  static forRecord(record: RecordDeclaration, set: ChoiceSet): DynamicModule {
    return {
      module: ChoicesRecordHost,
      imports: [ChoicesModule.forFeature({ sets: [set] }), RecordsModule],
      providers: [
        { provide: RECORD, useValue: record },
        { provide: RECORD_SET, useValue: set },
        ChoicesExtension,
      ],
    };
  }
}

/** The host of one `ChoicesModule.forFeature()`. */
@Module({})
class ChoiceSetsHost {}

/** The host of one `ChoicesModule.forRecord()`. */
@Module({})
class ChoicesRecordHost {}

/** A record's writes, checked against its set (a write by the system is not: it has no choices to pick). */
@RecordExtension()
@Injectable()
class ChoicesExtension implements RecordHooks {
  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    @Inject(RECORD_SET) private readonly set: ChoiceSet,
    private readonly choices: ChoicesService,
  ) {}

  async creating({
    values,
    by,
  }: {
    values: Record<string, unknown>;
    by: Principal;
  }) {
    await this.check(by, this.own(values));
  }

  async updating({
    before,
    changes,
    by,
  }: {
    before: Record<string, unknown>;
    changes: Record<string, unknown>;
    by: Principal;
  }) {
    const touched = this.own(changes);
    if (Object.keys(touched).length === 0) return;
    await this.check(by, { ...this.own(before), ...touched });
  }

  /** The set's fields among `values`. */
  private own(values: Record<string, unknown>) {
    return Object.fromEntries(
      Object.keys(this.set.fields)
        .filter((name) => name in values)
        .map((name) => [name, values[name]]),
    );
  }

  private async check(by: Principal, values: Record<string, unknown>) {
    if (by.kind === 'system') return;
    await this.choices.assertValid(by, this.set.key, values);
  }
}
