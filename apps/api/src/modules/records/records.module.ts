import {
  type DynamicModule,
  Injectable,
  Module,
  NotFoundException,
  type Type,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { and, isNull } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { HoldsModule } from '../../iam/holds/holds.module.js';
import { defineQuota, type StockQuota } from '../quotas/quota.js';
import { QuotasModule } from '../quotas/quotas.module.js';
import { recordKey } from './record.js';
import { RecordPurgeBridge } from './record-purge.bridge.js';
import { recordsConfig } from './records.config.js';
import { RecycleBinPurgeJob } from './recycle-bin.job.js';
import type { List } from '../../core/http/list-query.js';
import {
  AccessRecordFinder,
  type RecordFinder,
} from '../../iam/access/access-record-finder.js';
import { AccessModule } from '../../iam/access/access.module.js';
import type { Principal } from '../../iam/auth/principal.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { OrganizationModule } from '../../iam/organization/organization.module.js';
import type { RecordDeclaration, RecordTable } from './record.js';
import { RECORD } from './record-extension.js';
import type { RecordPolicy } from './record.policy.js';
import { IncludePipe, RecordPresenter } from './record.presenter.js';
import { restoreController } from './record.routes.js';
import type { RecordSchemas } from './record.schemas.js';
import { RecordStore } from './record.store.js';
import {
  RecordFeature,
  RecordRegistration,
  Records,
} from './records.service.js';

/**
 * Records (README.md): `Records`, which finds every record the app
 * registers and the extensions add-ons contribute, for the modules that
 * need them (lists, search, each add-on). A feature registers its record
 * with `RecordsModule.forFeature()` in its own imports.
 */
@Module({
  imports: [DiscoveryModule, ConfigModule.forFeature(recordsConfig)],
  providers: [Records, RecycleBinPurgeJob, RecordPurgeBridge],
  exports: [Records],
})
export class RecordsModule {
  /**
   * A feature's record: its store, presenter and `?include=` pipe for the
   * feature's service and controller, its declaration as `RECORD` (its
   * policy injects it), the recycle bin's restore route with `softDelete`,
   * and its registration (lists, search, add-ons find it; the access
   * explanation finds its records).
   *
   * ```ts
   * imports: [RecordsModule.forFeature(INVOICE, { table: invoices, list: INVOICE_LIST, schemas: INVOICE_SCHEMAS, policy: InvoicePolicy, quota: { label: 'Invoices' } })]
   * ```
   */
  static forFeature(
    declaration: RecordDeclaration,
    parts: {
      table: object;
      list: List;
      schemas: RecordSchemas;
      policy: Type<RecordPolicy>;
      /** A per-tenant limit on its live records (modules/quotas): off by default. */
      quota?: { label: string; default?: number | null };
    },
  ): DynamicModule {
    const table = parts.table as RecordTable;
    const quota = parts.quota && recordQuota(declaration, table, parts.quota);
    const feature = new RecordFeature(
      declaration,
      table,
      parts.list,
      parts.policy,
      parts.schemas,
      quota,
    );
    return {
      module: RecordFeatureModule,
      imports: [
        RecordsModule,
        AccessModule,
        AuditModule,
        OrganizationModule,
        HoldsModule,
        ...(quota ? [QuotasModule.forFeature(quota)] : []),
      ],
      controllers: declaration.softDelete
        ? [restoreController(declaration, parts.schemas)]
        : [],
      providers: [
        { provide: RecordFeature, useValue: feature },
        { provide: RECORD, useValue: declaration },
        RecordStore,
        RecordPresenter,
        IncludePipe,
        {
          provide: RecordRegistration,
          inject: [RecordStore, RecordPresenter],
          useFactory: (store: RecordStore, presenter: RecordPresenter) =>
            new RecordRegistration(feature, store, presenter),
        },
        recordFinder(declaration),
      ],
      exports: [
        RecordsModule,
        RECORD,
        RecordFeature,
        RecordStore,
        RecordPresenter,
        IncludePipe,
      ],
    };
  }
}

/**
 * A record's stock quota (`records.<item>`): its live records in the
 * tenant, checked by RecordStore.create() in the insert's transaction (422
 * `quota_exceeded`).
 */
function recordQuota(
  declaration: RecordDeclaration,
  table: RecordTable,
  { label, default: limit }: { label: string; default?: number | null },
): StockQuota {
  return defineQuota({
    key: `records.${recordKey(declaration)}`,
    label,
    kind: 'stock',
    ...(limit !== undefined && { default: limit }),
    count: (db) =>
      db.$count(
        table as unknown as PgTable,
        and(declaration.softDelete ? isNull(table.deletedAt!) : undefined),
      ),
  });
}

/** The host of one forFeature() registration. */
@Module({})
class RecordFeatureModule {}

/**
 * The access explanation's finder of a record's rows (`?recordId=`,
 * iam/access): the row its routes would load for `visibleTo`, or null.
 */
function recordFinder(declaration: RecordDeclaration): Type {
  @AccessRecordFinder(declaration.subject)
  @Injectable()
  class Finder implements RecordFinder {
    constructor(private readonly store: RecordStore) {}

    find(id: string, visibleTo: Principal) {
      return this.store.findOne(id, { visibleTo }).catch((error: unknown) => {
        if (error instanceof NotFoundException) return null;
        throw error;
      });
    }
  }
  Object.defineProperty(Finder, 'name', {
    value: `${declaration.subject}RecordFinder`,
  });
  return Finder;
}
