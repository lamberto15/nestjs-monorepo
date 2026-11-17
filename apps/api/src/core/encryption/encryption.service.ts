import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { DiscoveryService } from '@nestjs/core';
import { inArray, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  type Binding,
  BlindIndexer,
  DataCipher,
  FORMAT,
} from './data-cipher.js';
import {
  type EncryptedColumn,
  EncryptedColumns,
  encryptedColumn,
} from './encrypted-columns.js';
import { encryptionConfig } from './encryption.config.js';

/**
 * The tenant seam. Rows of a tenant table are bound to their tenant; the
 * tenancy module provides this (from a global module) with the current
 * tenant, so services needn't pass it. Without a provider, a tenant table's
 * calls name the tenant themselves (`tenantId` argument), which is also what
 * a job working for one tenant does.
 */
export abstract class EncryptionTenant {
  abstract current(): string | undefined;
}

/**
 * Encrypts and decrypts the declared columns with the deployment's keys,
 * bound to their table, column and tenant. Services call it where they write
 * and read the column.
 *
 * ```ts
 * await db.insert(customers).values({ name, ...this.encryption.seal(customers.taxNumber, taxNumber) });
 * const rows = await db.select().from(customers).where(this.encryption.lookup(customers.taxNumber, taxNumber));
 * const plain = this.encryption.decrypt(customers.taxNumber, rows[0].taxNumber);
 * ```
 */
@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly logger = new Logger('Encryption');
  private readonly cipher: DataCipher;
  private readonly indexer: BlindIndexer;
  private discovered?: EncryptedColumn[];

  constructor(
    @Inject(encryptionConfig.KEY)
    config: ConfigType<typeof encryptionConfig>,
    private readonly discovery: DiscoveryService,
    @Optional() private readonly tenant?: EncryptionTenant,
  ) {
    if (config.dataKeys.some((key) => config.indexKeys.includes(key))) {
      throw new Error(
        'BLIND_INDEX_KEYS and DATA_ENCRYPTION_KEYS share a key: give each its own.',
      );
    }
    this.cipher = new DataCipher(config.dataKeys);
    this.indexer = new BlindIndexer(config.indexKeys);
  }

  /**
   * Boot is refused when a column is declared encrypted (or indexed) and
   * its keys are missing: a write would fail later, or a read find nothing.
   */
  onModuleInit() {
    const columns = this.columns();
    if (columns.length > 0 && !this.cipher.configured) {
      throw new Error(
        `DATA_ENCRYPTION_KEYS is not set, and ${columns.length} column(s) are encrypted (${describe(columns)}).`,
      );
    }
    const indexed = columns.filter((column) => column.blindIndex);
    if (indexed.length > 0 && !this.indexer.configured) {
      throw new Error(
        `BLIND_INDEX_KEYS is not set, and ${indexed.length} column(s) have a blind index (${describe(indexed)}).`,
      );
    }
    if (columns.length > 0) {
      this.logger.log(
        `${columns.length} encrypted column(s), key ${this.cipher.currentKeyId}`,
      );
    }
  }

  /**
   * Every column a provider declared with `@EncryptedColumns`, wherever in
   * the app that provider is: how the boot check and the re-encryption find
   * a module's columns without a central list.
   */
  columns(): readonly EncryptedColumn[] {
    this.discovered ??= this.discovery
      .getProviders({ metadataKey: EncryptedColumns.KEY })
      .flatMap(
        (wrapper) =>
          this.discovery.getMetadataByDecorator(EncryptedColumns, wrapper) ??
          [],
      )
      .map(encryptedColumn);
    return this.discovered;
  }

  /**
   * The row properties holding an encrypted value or a blind index, in any
   * module: what must never reach a revision, an audit entry, an export or a
   * webhook payload in the clear, nor a log line (by property name, so a
   * view built from a row, with no table at hand, is covered too).
   */
  properties(): ReadonlySet<string> {
    return new Set(
      this.columns().flatMap((entry) => [
        entry.key,
        ...(entry.blindIndex ? [entry.blindIndex.key] : []),
      ]),
    );
  }

  /** `value` without the encrypted properties, at any depth (objects and arrays). */
  withoutEncrypted<T>(value: T): T {
    const names = this.properties();
    return names.size === 0 ? value : strip(value, names);
  }

  /** The key version new values get. */
  get currentKeyId(): string | undefined {
    return this.cipher.currentKeyId;
  }

  /** The stored form of `plaintext` in `column` (null stays null). */
  encrypt(
    column: PgColumn,
    plaintext: string,
    tenantId?: string | null,
  ): string;
  encrypt(
    column: PgColumn,
    plaintext: string | null | undefined,
    tenantId?: string | null,
  ): string | null;
  encrypt(
    column: PgColumn,
    plaintext: string | null | undefined,
    tenantId?: string | null,
  ): string | null {
    if (plaintext === null || plaintext === undefined) {
      return null;
    }
    return this.cipher.encrypt(plaintext, this.binding(column, tenantId));
  }

  /** The plaintext of a stored value of `column` (null stays null); a DecryptionError when it doesn't open. */
  decrypt(column: PgColumn, stored: string, tenantId?: string | null): string;
  decrypt(
    column: PgColumn,
    stored: string | null | undefined,
    tenantId?: string | null,
  ): string | null;
  decrypt(
    column: PgColumn,
    stored: string | null | undefined,
    tenantId?: string | null,
  ): string | null {
    if (stored === null || stored === undefined) {
      return null;
    }
    return this.cipher.decrypt(stored, this.binding(column, tenantId));
  }

  /** The blind index of `value` under the current key (normalized first). */
  blindIndex(
    column: PgColumn,
    value: string,
    tenantId?: string | null,
  ): string {
    const { normalize } = this.indexOf(column);
    return this.indexer.index(normalize(value), this.binding(column, tenantId));
  }

  /**
   * The condition finding the rows whose `column` holds `value`: its blind
   * index under every configured key, so rows not yet re-indexed after a
   * rotation are found too.
   */
  lookup(column: PgColumn, value: string, tenantId?: string | null): SQL {
    const index = this.indexOf(column);
    return inArray(
      index.column,
      this.indexer.indexes(
        index.normalize(value),
        this.binding(column, tenantId),
      ),
    );
  }

  /**
   * The values to write for `plaintext`: the column's ciphertext and, when
   * it has one, its blind index, by their row properties
   * (`{ taxNumber, taxNumberIndex }`), for an insert or an update.
   */
  seal(
    column: PgColumn,
    plaintext: string | null,
    tenantId?: string | null,
  ): Record<string, string | null> {
    const entry = encryptedColumn(column);
    const values: Record<string, string | null> = {
      [entry.key]: this.encrypt(column, plaintext, tenantId),
    };
    if (entry.blindIndex) {
      values[entry.blindIndex.key] =
        plaintext === null
          ? null
          : this.blindIndex(column, plaintext, tenantId);
    }
    return values;
  }

  /**
   * Whether a stored row needs re-encryption: its value isn't in today's
   * format under the current key, or its blind index isn't under the current
   * index key.
   */
  isStale(
    entry: EncryptedColumn,
    stored: string | null,
    storedIndex?: string | null,
  ): boolean {
    if (stored === null) {
      return false;
    }
    if (!this.cipher.isCurrent(stored)) {
      return true;
    }
    return (
      entry.blindIndex !== undefined &&
      this.indexer.keyIdOf(storedIndex ?? '') !== this.indexer.currentKeyId
    );
  }

  /**
   * A stored value (and its index) rewritten under the current keys. A
   * DecryptionError when it doesn't open (a key removed too early, a value
   * moved by hand).
   */
  rewrite(
    entry: EncryptedColumn,
    stored: string,
    tenantId: string | null,
  ): { value: string; index?: string } {
    const plaintext = this.decrypt(entry.column, stored, tenantId);
    return {
      value: this.encrypt(entry.column, plaintext, tenantId),
      index: entry.blindIndex
        ? this.blindIndex(entry.column, plaintext, tenantId)
        : undefined,
    };
  }

  /** The prefix every value under the current key starts with (`v1.<key id>.`). */
  currentPrefix(): string | undefined {
    return this.cipher.currentKeyId
      ? `${FORMAT}.${this.cipher.currentKeyId}.`
      : undefined;
  }

  /** The prefix every blind index under the current key starts with (`<key id>.`). */
  currentIndexPrefix(): string | undefined {
    return this.indexer.currentKeyId
      ? `${this.indexer.currentKeyId}.`
      : undefined;
  }

  /** The key version of a stored value (for logs and metrics), undefined when it isn't one. */
  keyIdOf(stored: string): string | undefined {
    return this.cipher.keyIdOf(stored);
  }

  private indexOf(column: PgColumn) {
    const entry = encryptedColumn(column);
    if (!entry.blindIndex) {
      throw new Error(
        `${entry.bindingTable}.${entry.bindingColumn} has no blind index: it can't be looked up by value.`,
      );
    }
    return entry.blindIndex;
  }

  private binding(column: PgColumn, tenantId?: string | null): Binding {
    const entry = encryptedColumn(column);
    const where = `${entry.bindingTable}.${entry.bindingColumn}`;
    if (!entry.tenantColumn) {
      return {
        table: entry.bindingTable,
        column: entry.bindingColumn,
        tenantId: null,
      };
    }
    const tenant = tenantId ?? this.tenant?.current();
    if (!tenant) {
      throw new Error(`Encrypting ${where} needs a tenant.`);
    }
    return {
      table: entry.bindingTable,
      column: entry.bindingColumn,
      tenantId: tenant,
    };
  }
}

const describe = (columns: readonly EncryptedColumn[]) =>
  columns
    .map((column) => `${column.bindingTable}.${column.bindingColumn}`)
    .join(', ');

function strip(value: unknown, names: ReadonlySet<string>): never {
  if (Array.isArray(value)) {
    return value.map((item) => strip(item, names)) as never;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !names.has(key))
        .map(([key, item]) => [key, strip(item, names)]),
    ) as never;
  }
  return value as never;
}
