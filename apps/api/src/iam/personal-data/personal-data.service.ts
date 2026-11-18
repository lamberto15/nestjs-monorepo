import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { memberships } from '../auth/auth.tables.js';
import {
  PersonalData,
  type PersonalDataOptions,
  type PersonalDataSection,
  type PersonalDataSubject,
  type PersonalRow,
} from './personal-data.js';

interface Found {
  options: PersonalDataOptions;
  section: PersonalDataSection;
}

/** A batch of the export: the section, the tenant it comes from (null: the account's own), its rows. */
export interface PersonalDataBatch {
  section: string;
  tenantId: string | null;
  rows: PersonalRow[];
}

/**
 * The sections found at start (`@PersonalData()`): the person's data
 * export, and the erasure the account's deletion runs. A name two
 * providers use fails the boot.
 */
@Injectable()
export class PersonalDataService implements OnModuleInit {
  private sections: Found[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly tenancy: Tenancy,
    @InjectTransaction() private readonly db: Database,
  ) {}

  onModuleInit() {
    const names = new Set<string>();
    const seen = new Set<unknown>();
    for (const wrapper of this.discovery.getProviders({
      metadataKey: PersonalData.KEY,
    })) {
      const section = wrapper.instance as PersonalDataSection | undefined;
      const options = this.discovery.getMetadataByDecorator(
        PersonalData,
        wrapper,
      );
      if (!section || !options || seen.has(section)) continue;
      seen.add(section);
      if (names.has(options.name)) {
        throw new Error(
          `Two personal data sections are named "${options.name}": keep one.`,
        );
      }
      names.add(options.name);
      this.sections.push({ options, section });
    }
  }

  /** The tenants a person belongs to, active or not: each holds some of their data. */
  async tenantsOf(userId: string) {
    const rows = await this.tenancy.run(null, () =>
      this.db
        .select({ tenantId: memberships.tenantId })
        .from(memberships)
        .where(eq(memberships.userId, userId)),
    );
    return rows.map((row) => row.tenantId);
  }

  /**
   * Everything held about the person, batch by batch, to `write`: the
   * account's own sections, then each tenant's. Call it outside a
   * transaction (each scope opens its own context).
   */
  async export(
    userId: string,
    write: (batch: PersonalDataBatch) => Promise<void>,
  ) {
    const scopes: (string | null)[] = [null, ...(await this.tenantsOf(userId))];
    for (const tenantId of scopes) {
      const subject = subjectOf(userId, tenantId);
      await this.tenancy.run(tenantId, async () => {
        for (const { options, section } of this.in(tenantId)) {
          if (!section.rows) continue;
          for await (const rows of batches(section.rows(subject))) {
            if (rows.length > 0) {
              await write({ section: options.name, tenantId, rows });
            }
          }
        }
      });
    }
  }

  /**
   * Every section's erasure in the current scope (`tenantId`: the one the
   * caller runs in, in its transaction). The deletion job calls it once
   * per tenant, then once in no tenant.
   */
  async erase(userId: string, tenantId: string | null) {
    const subject = subjectOf(userId, tenantId);
    for (const { section } of this.in(tenantId)) {
      await section.erase?.(subject);
    }
  }

  /** The sections asked in this scope, in the order they were found. */
  private in(tenantId: string | null) {
    const scope = tenantId === null ? 'account' : 'tenant';
    return this.sections.filter(({ options }) =>
      options.scopes.includes(scope),
    );
  }
}

const subjectOf = (
  userId: string,
  tenantId: string | null,
): PersonalDataSubject => ({ userId, key: `user:${userId}`, tenantId });

async function* batches(
  rows: Promise<PersonalRow[]> | AsyncIterable<PersonalRow[]>,
): AsyncIterable<PersonalRow[]> {
  if (Symbol.asyncIterator in rows) {
    yield* rows;
  } else {
    yield await rows;
  }
}
