import { randomBytes } from 'node:crypto';
import type { DiscoveryService } from '@nestjs/core';
import { PgDialect, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { normalizers } from './data-cipher.js';
import {
  blindIndexText,
  EncryptedColumns,
  encrypted,
  encryptedColumn,
  encryptedText,
} from './encrypted-columns.js';
import { EncryptionService } from './encryption.service.js';

const customers = pgTable('spec_customers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  taxNumber: encryptedText('tax_number'),
  taxNumberIndex: blindIndexText('tax_number_index'),
  note: text('note'),
});
const settings = pgTable('spec_settings', {
  id: uuid('id').primaryKey(),
  apiSecret: encryptedText('api_secret'),
});
encrypted(customers.taxNumber, {
  blindIndex: customers.taxNumberIndex,
  normalize: normalizers.exact,
});
encrypted(settings.apiSecret);

const TENANT = '0190f5d6-6d5a-7000-8000-000000000001';
const OTHER = '0190f5d6-6d5a-7000-8000-000000000002';
const key = () => randomBytes(32).toString('base64');

/** A service whose discovery finds one provider listing `columns`. */
const service = (
  keys: { dataKeys?: string[]; indexKeys?: string[] },
  columns = [customers.taxNumber, settings.apiSecret],
) =>
  new EncryptionService({ dataKeys: [], indexKeys: [], ...keys }, {
    getProviders: () => [{}],
    getMetadataByDecorator: () => columns,
  } as unknown as DiscoveryService);

describe('encrypted(): the declaration', () => {
  it('reads the binding and tenant from the table', () => {
    expect(encryptedColumn(customers.taxNumber)).toMatchObject({
      key: 'taxNumber',
      bindingTable: 'spec_customers',
      bindingColumn: 'tax_number',
      blindIndex: { key: 'taxNumberIndex' },
    });
    expect(encryptedColumn(customers.taxNumber).tenantColumn).toBe(
      customers.tenantId,
    );
    expect(encryptedColumn(settings.apiSecret).tenantColumn).toBeUndefined();
  });

  it('refuses a second declaration, a non-text column, an index without a normalizer', () => {
    expect(() => encrypted(customers.taxNumber)).toThrow(/twice/);
    expect(() => encrypted(customers.tenantId)).toThrow(/is text/);
    expect(() =>
      encrypted(customers.note, { blindIndex: customers.taxNumberIndex }),
    ).toThrow(/normalizer/);
    expect(() => encryptedColumn(customers.note)).toThrow(/not declared/);
  });

  it('is discoverable by its decorator key', () => {
    expect(typeof EncryptedColumns.KEY).toBe('string');
  });
});

describe('EncryptionService', () => {
  it('finds the columns of the providers that list them', () => {
    expect(
      service({})
        .columns()
        .map((c) => c.bindingTable),
    ).toEqual(['spec_customers', 'spec_settings']);
  });

  it('refuses to boot without keys once a column is encrypted or indexed', () => {
    expect(() => service({}).onModuleInit()).toThrow(
      /DATA_ENCRYPTION_KEYS is not set.*spec_customers\.tax_number/,
    );
    expect(() => service({ dataKeys: [key()] }).onModuleInit()).toThrow(
      /BLIND_INDEX_KEYS is not set/,
    );
    expect(() =>
      service({ dataKeys: [key()], indexKeys: [key()] }).onModuleInit(),
    ).not.toThrow();
    expect(() => service({}, []).onModuleInit()).not.toThrow();
  });

  it('refuses the same key for data and indexes', () => {
    const shared = key();
    expect(() => service({ dataKeys: [shared], indexKeys: [shared] })).toThrow(
      /share a key/,
    );
  });

  it('seals a value with its index, binds it to the tenant, and finds it by value', () => {
    const encryption = service({ dataKeys: [key()], indexKeys: [key()] });
    const sealed = encryption.seal(customers.taxNumber, ' DE123 ', TENANT);
    expect(Object.keys(sealed)).toEqual(['taxNumber', 'taxNumberIndex']);
    expect(
      encryption.decrypt(customers.taxNumber, sealed.taxNumber, TENANT),
    ).toBe(' DE123 ');
    expect(() =>
      encryption.decrypt(customers.taxNumber, sealed.taxNumber, OTHER),
    ).toThrow(/authentication failed/);
    // Normalized (exact: trimmed) before indexing.
    expect(sealed.taxNumberIndex).toBe(
      encryption.blindIndex(customers.taxNumber, 'DE123', TENANT),
    );
    const condition = new PgDialect().sqlToQuery(
      encryption.lookup(customers.taxNumber, 'DE123', TENANT),
    );
    expect(condition.sql).toContain('"tax_number_index" in');
    expect(condition.params).toEqual([sealed.taxNumberIndex]);
    expect(encryption.seal(customers.taxNumber, null, TENANT)).toEqual({
      taxNumber: null,
      taxNumberIndex: null,
    });
  });

  it('takes the tenant from the seam when none is given', () => {
    const encryption = new EncryptionService(
      { dataKeys: [key()], indexKeys: [key()] },
      {} as DiscoveryService,
      { current: () => TENANT },
    );
    const stored = encryption.encrypt(customers.taxNumber, 'x');
    expect(encryption.decrypt(customers.taxNumber, stored, TENANT)).toBe('x');
  });

  it('needs the tenant for a tenant table, none for a global one', () => {
    const encryption = service({ dataKeys: [key()], indexKeys: [key()] });
    expect(() => encryption.encrypt(customers.taxNumber, 'x')).toThrow(
      /needs a tenant/,
    );
    const stored = encryption.encrypt(settings.apiSecret, 'x');
    expect(encryption.decrypt(settings.apiSecret, stored)).toBe('x');
    expect(() => encryption.lookup(settings.apiSecret, 'x')).toThrow(
      /no blind index/,
    );
  });

  it('knows a stale row and rewrites it under the current keys', () => {
    const [oldData, oldIndex] = [key(), key()];
    const before = service({ dataKeys: [oldData], indexKeys: [oldIndex] });
    const sealed = before.seal(customers.taxNumber, 'DE123', TENANT);
    const entry = encryptedColumn(customers.taxNumber);
    expect(before.isStale(entry, sealed.taxNumber, sealed.taxNumberIndex)).toBe(
      false,
    );

    const afterData = service({
      dataKeys: [key(), oldData],
      indexKeys: [oldIndex],
    });
    expect(
      afterData.isStale(entry, sealed.taxNumber, sealed.taxNumberIndex),
    ).toBe(true);
    const afterIndex = service({
      dataKeys: [oldData],
      indexKeys: [key(), oldIndex],
    });
    expect(
      afterIndex.isStale(entry, sealed.taxNumber, sealed.taxNumberIndex),
    ).toBe(true);

    const rewritten = afterData.rewrite(entry, sealed.taxNumber!, TENANT);
    expect(afterData.keyIdOf(rewritten.value)).toBe(afterData.currentKeyId);
    expect(rewritten.value.startsWith(afterData.currentPrefix()!)).toBe(true);
    expect(rewritten.index?.startsWith(afterData.currentIndexPrefix()!)).toBe(
      true,
    );
    expect(
      afterData.decrypt(customers.taxNumber, rewritten.value, TENANT),
    ).toBe('DE123');
    expect(afterData.isStale(entry, rewritten.value, rewritten.index)).toBe(
      false,
    );
    expect(afterData.isStale(entry, null)).toBe(false);
  });

  it('knows the encrypted properties and strips them at any depth', () => {
    const encryption = service({});
    const names = encryption.properties();
    expect(names.has('taxNumber')).toBe(true);
    expect(names.has('taxNumberIndex')).toBe(true);
    expect(names.has('id')).toBe(false);
    const when = new Date();
    expect(
      encryption.withoutEncrypted({
        name: 'Ada',
        taxNumber: 'v1.k.iv.ct.tag',
        taxNumberIndex: 'k.mac',
        when,
        nested: { apiSecret: 'x', taxNumber: 'x', kept: 1 },
        list: [{ taxNumber: 'y', ok: true }],
      }),
    ).toEqual({
      name: 'Ada',
      when,
      nested: { kept: 1 },
      list: [{ ok: true }],
    });
  });
});
