import { Injectable, type OnModuleInit, type Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { List } from '../../core/http/list-query.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { StockQuota } from '../quotas/quota.js';
import type { RecordDeclaration, RecordTable } from './record.js';
import {
  RECORD_CONTROLLER,
  RecordExtension,
  type RecordHooks,
} from './record-extension.js';
import type { RecordPolicy } from './record.policy.js';
import type { RecordPresenter } from './record.presenter.js';
import type { RecordSchemas } from './record.schemas.js';
import type { RecordStore } from './record.store.js';

/**
 * What a feature hands RecordsModule.forFeature(): its declaration and what
 * its own files derived from it (the table, the list, the policy). Its
 * module's providers inject it. Nest hashes a dynamic module's metadata:
 * the subject names it (a table and a list don't serialize).
 */
export class RecordFeature {
  constructor(
    readonly declaration: RecordDeclaration,
    readonly table: RecordTable,
    readonly list: List,
    readonly policy: Type<RecordPolicy>,
    /** Its bodies and response, with what its add-ons add (modules/mcp's tools take them). */
    readonly schemas: RecordSchemas,
    /** The stock quota of its records, when `forFeature({ quota })` set one. */
    readonly quota?: StockQuota,
  ) {}

  toJSON() {
    return `record:${this.declaration.subject}`;
  }
}

/**
 * One record of the app, as the modules that need "every record" or "this
 * subject's record" read it: its declaration, table, policy, store and
 * presenter, the extensions its add-ons registered, and its list with
 * their filters. Provided by RecordsModule.forFeature(); found by Records.
 */
export class RecordRegistration {
  readonly extensions: RecordHooks[] = [];
  /** The feature's list, with what its extensions add (filters, `fields=` names). */
  list: List;

  constructor(
    readonly feature: RecordFeature,
    readonly store: RecordStore,
    readonly presenter: RecordPresenter,
  ) {
    this.list = feature.list;
  }

  /**
   * The list a request's query is parsed with: the record's (with its
   * extensions' `filters`), plus what their `listFields()` give for this
   * principal (RecordPresenter.query, GET /v1/lists/{subject}).
   */
  async listFor(principal: Principal): Promise<List> {
    let list = this.list;
    for (const hooks of this.extensions) {
      if (!hooks.listFields) continue;
      const more = await hooks.listFields(principal);
      list = list.extend(more.fields, more.select ?? []);
    }
    return list;
  }

  get declaration() {
    return this.feature.declaration;
  }
}

/**
 * Every record registered (RecordsModule.forFeature()), and the extensions
 * add-ons marked `@RecordExtension()`, found at startup (DiscoveryService):
 * no list to append to. `of(subject)` is how an add-on, the list
 * descriptions and the search reach a record.
 */
@Injectable()
export class Records implements OnModuleInit {
  private readonly records = new Map<string, RecordRegistration>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    this.refuseTwoControllers();
    for (const wrapper of this.discovery.getProviders()) {
      const found: unknown = wrapper.instance;
      if (!(found instanceof RecordRegistration)) continue;
      const { subject } = found.declaration;
      if (this.records.has(subject) && this.records.get(subject) !== found) {
        throw new Error(`Two records are registered as ${subject}.`);
      }
      this.records.set(subject, found);
    }
    for (const wrapper of this.discovery.getProviders({
      metadataKey: RecordExtension.KEY,
    })) {
      const hooks = wrapper.instance as RecordHooks | undefined;
      if (!hooks) continue;
      const registration = this.records.get(hooks.record.subject);
      if (!registration) {
        throw new Error(
          `${wrapper.name} extends ${hooks.record.subject}, which no module registers: import RecordsModule.forFeature(${hooks.record.subject.toUpperCase()}) in its feature module.`,
        );
      }
      if (!registration.extensions.includes(hooks)) {
        registration.extensions.push(hooks);
      }
    }
    for (const registration of this.records.values()) {
      const { table } = registration.feature;
      let list = registration.feature.list;
      for (const hooks of registration.extensions) {
        if (hooks.filters || hooks.shows) {
          list = list.extend(hooks.filters?.(table) ?? {}, hooks.shows ?? []);
        }
      }
      registration.list = list;
    }
  }

  /** Two record controllers of one name (two forRecord() of an add-on for one record): a mistake. */
  private refuseTwoControllers() {
    const seen = new Set<string>();
    for (const wrapper of this.discovery.getControllers()) {
      const type = wrapper.metatype as object | null;
      if (!type || !Reflect.getMetadata(RECORD_CONTROLLER, type)) continue;
      if (seen.has(wrapper.name)) {
        throw new Error(`Two record controllers are named ${wrapper.name}.`);
      }
      seen.add(wrapper.name);
    }
  }

  /** The record registered as `subject`, or undefined. */
  find(subject: string): RecordRegistration | undefined {
    return this.records.get(subject);
  }

  /** The record registered as `subject`: a module asking for one that isn't is a bug. */
  of(subject: string): RecordRegistration {
    const found = this.records.get(subject);
    if (!found) {
      throw new Error(`No record is registered as ${subject}.`);
    }
    return found;
  }

  all(): RecordRegistration[] {
    return [...this.records.values()];
  }
}
