import { Inject } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Controller, applyDecorators } from '@nestjs/common';
import type { FilterField } from '../../core/http/list-query.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { RecordDeclaration, RecordRow, RecordTable } from './record.js';

/**
 * The extension contract (README.md, "Writing an add-on"): how a module
 * adds to every record that opts into it, with no line in the engine. A
 * feature opts in by importing the add-on's dynamic module
 * (`TagsModule.forRecord(INVOICE)`); in it, the add-on
 *
 * - provides the record's declaration as `RECORD` (`{ provide: RECORD, useValue: INVOICE }`),
 * - mounts its routes under the record's path with `@RecordController()`,
 *   checking the record with `Records.of(subject)` (its store and policy),
 * - and marks one provider `@RecordExtension()` implementing `RecordHooks`:
 *   what it does in a write's transaction, shows on the record, adds to the
 *   list and to the list's description.
 *
 * After the commit it reacts to the record's domain events
 * (`recordEvents(INVOICE).created`… with `@OnDomainEvent()`, core/outbox).
 */

/** The record an add-on's dynamic module (or a feature module) works for: its declaration. */
export const RECORD = Symbol('RECORD');

/** Injects the declaration of the record the module works for (`RECORD`). */
export const InjectRecord = () => Inject(RECORD);

/** Marks a provider implementing `RecordHooks` for the record of its module (Records finds it). */
export const RecordExtension = DiscoveryService.createDecorator<void>();

/** A change of a record, as a hook receives it: the row as stored. */
export interface RecordChange {
  row: RecordRow;
  by: Principal;
  /** The request's validated body (`{}` for a write with none: a delete, a system job). */
  input: Record<string, unknown>;
}

/** Column values a before-hook adds to the write (merged over the service's). */
export type RecordValues = Record<string, unknown>;

/**
 * What an add-on adds to a record, each part optional. Every write hook
 * runs in the transaction of the change and joins it through
 * `@InjectTransaction()`: throwing refuses the change and rolls it back.
 * `creating` and `updating` run before the row is written and may return
 * column values to merge into it; the others run after it (`deleting`:
 * before the delete).
 */
export interface RecordHooks {
  /** The record it extends: `@InjectRecord() readonly record: RecordDeclaration`. */
  readonly record: RecordDeclaration;

  /** Before the insert: `values` as they stand (the service's, earlier hooks'). */
  creating?(change: {
    values: RecordValues;
    owner: Principal;
    by: Principal;
    input: Record<string, unknown>;
  }): Promise<RecordValues | void>;
  created?(change: RecordChange): Promise<void>;
  /** Before the update, on the locked row: `changes` as they stand. Runs even when no column changes. */
  updating?(change: {
    before: RecordRow;
    changes: RecordValues;
    by: Principal;
    input: Record<string, unknown>;
  }): Promise<RecordValues | void>;
  updated?(change: {
    before: RecordRow;
    after: RecordRow;
    by: Principal;
    input: Record<string, unknown>;
  }): Promise<void>;
  /** Before a delete (to the recycle bin or for good): a refusal throws (409). */
  deleting?(change: RecordChange): Promise<void>;
  /** `row` as it is once deleted (in the recycle bin, or as it was). */
  deleted?(change: RecordChange): Promise<void>;
  restored?(change: RecordChange): Promise<void>;
  /**
   * Before records are deleted for good (a delete without recycle bin, the
   * recycle bin's purge, a retention rule): remove what the add-on keeps
   * about them in its own tables.
   */
  purged?(change: { ids: readonly string[]; by: Principal }): Promise<void>;

  /**
   * The keys it adds to every record shown (`tags`): `fields=` may pick
   * them. `present()` adds them, for a page at once (one query), before
   * field-level redaction. They must change only in a write (the record's
   * or the add-on's own route), never in a subscriber: they are in the ETag.
   */
  readonly shows?: readonly string[];
  present?(
    principal: Principal,
    views: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]>;

  /**
   * One `?include=` value it answers (`watching`), about the reader or
   * changing outside the record's writes: left out of the ETag. `values`
   * by record id.
   */
  readonly include?: {
    name: string;
    values(principal: Principal, ids: string[]): Promise<Map<string, unknown>>;
  };

  /** List filters and sorts it adds (`?tag=`), on the record's table. */
  filters?(table: RecordTable): Record<string, FilterField>;

  /** Its name in the list description's `capabilities` (GET /v1/lists/{subject}). */
  readonly capability?: string;
  /** Whether it works in this deployment (a switch it needs): default true. */
  available?(): boolean;
  /** Keys it adds to the list description (`attachmentLimits`), for this caller. */
  describe?(principal: Principal): Promise<Record<string, unknown>>;
}

/** Marks a class made by `@RecordController()`: Records refuses two of one name in an app. */
export const RECORD_CONTROLLER = Symbol('RECORD_CONTROLLER');

/**
 * A controller under a record's path: `/v1/<path>` + `segment`
 * (`':id/tags'`), with the record's Swagger tag and security schemes, named
 * `<Subject><suffix>Controller` (its operationIds), not `mixin()`'s random
 * name. Two of one name in one app fail its start (Records). Declare the
 * class inside the add-on's `forRecord()`, so each record gets its own.
 *
 * ```ts
 * @RecordController(record, ':id/tags', 'Tags')
 * class TagRoutes { … }
 * ```
 */
export const RecordController =
  (
    record: RecordDeclaration,
    segment: string,
    suffix: string,
  ): ClassDecorator =>
  (target) => {
    Object.defineProperty(target, 'name', {
      value: `${record.subject}${suffix}Controller`,
    });
    Reflect.defineMetadata(RECORD_CONTROLLER, true, target);
    applyDecorators(
      Controller(segment ? `${record.path}/${segment}` : record.path),
      ApiUnauthorizedResponse({ description: 'No valid API key or session.' }),
      ApiCookieAuth('user-session'),
      ApiBearerAuth('user-token'),
      ApiBearerAuth('api-key'),
      ApiTags(record.apiTag ?? record.path),
    )(target);
  };
