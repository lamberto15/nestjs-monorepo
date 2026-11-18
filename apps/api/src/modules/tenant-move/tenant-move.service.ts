import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { StorageDisk } from '@nestjs/storage';
import {
  and,
  asc,
  count,
  eq,
  getColumnTable,
  getColumns,
  getTableName,
  inArray,
  isNotNull,
  ne,
  or,
} from 'drizzle-orm';
import {
  getTableConfig,
  type PgColumn,
  type PgTable,
} from 'drizzle-orm/pg-core';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import { schemaVersion } from '../../core/database/migrations.js';
import type { EncryptedColumn } from '../../core/encryption/encrypted-columns.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { afterKey, pagingKey } from '../../core/tenancy/table-paging.js';
import { tenancyConfig } from '../../core/tenancy/tenancy.config.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { type Tenant, tenants } from '../../core/tenancy/tenancy.tables.js';
import { tenantTables } from '../../core/tenancy/tenant-tables.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { accountRowTables } from '../../iam/auth/account-rows.js';
import { memberships, users } from '../../iam/auth/auth.tables.js';
import { normalizeEmail } from '../../iam/auth/users.repository.js';
import type { Principal, SystemPrincipal } from '../../iam/auth/principal.js';
import { AccountDeletionJob } from '../../iam/personal-data/account-deletion.job.js';
import { TenantsService } from '../../iam/tenants/tenants.service.js';
import {
  ArchiveError,
  archiveKey,
  type FileEntry,
  type Manifest,
  newArchiveKey,
  readEncrypted,
  readManifest,
  readRows,
  type TableEntry,
  writeEncrypted,
  writeManifest,
  ARCHIVE_FORMAT,
} from './move-archive.js';
import {
  columnOf,
  decodeRow,
  encodeRow,
  insertOrder,
  outsideReferences,
  selfReference,
  writable,
} from './move-rows.js';

/** Why a step of a move did not run: a sentence for the operator, nothing changed. */
export class MoveRefused extends Error {}

/** Rows read per page of a table, and ids per `in (…)`. */
const PAGE = 1000;
/** Parameters per insert stay well under PostgreSQL's 65535. */
const PARAMETERS = 30_000;

/** A table of the archive, resolved to this server's declaration. */
interface Resolved extends TableEntry {
  table: PgTable;
}

/** What a tenant's account rows are found by: the copied accounts' ids, or their keys. */
const ownerValues = (form: 'id' | 'key', ids: readonly string[]) =>
  form === 'id' ? ids : ids.map((id) => `user:${id}`);

const chunks = <T>(values: readonly T[], size = PAGE) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );

const accountFile = (ids: ReadonlySet<string>) => (value: unknown) =>
  typeof value === 'string' &&
  /^accounts\/[0-9a-f-]{36}\//.test(value) &&
  !value.includes('..') &&
  ids.has(value.slice('accounts/'.length, 'accounts/'.length + 36));

/**
 * Moves one tenant from a shared server to a server of its own (README.md):
 * `export()` on the source writes the archive of a frozen tenant (every row
 * that names it, the accounts its rows point at with their own rows, its
 * files and theirs), `import()` on the target puts it back and verifies it,
 * `finish()` erases it from the source. The same release runs on both.
 */
@Injectable()
export class TenantMoveService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly tenantsService: TenantsService,
    private readonly encryption: EncryptionService,
    private readonly disk: StorageDisk,
    private readonly audit: AuditService,
    private readonly accountDeletion: AccountDeletionJob,
    @Inject(tenancyConfig.KEY)
    private readonly tenancyMode: ConfigType<typeof tenancyConfig>,
  ) {}

  /** Work on global tables: in no tenant. */
  private global<T>(work: () => Promise<T>) {
    return this.tenancy.run(null, work);
  }

  private async tenantOf(tenantId: string) {
    const tenant = await this.global(() => this.tenancy.find(tenantId));
    if (!tenant) throw new MoveRefused('The tenant no longer exists.');
    return tenant;
  }

  /** Freezes the tenant for its move, or thaws it (TenantsService.setFrozen()). */
  freeze(
    actor: Principal,
    tenantId: string,
    frozen: boolean,
    details: Record<string, unknown> = {},
  ) {
    return this.tenantsService.setFrozen(actor, tenantId, frozen, {
      ...details,
      reason: 'move',
    });
  }

  // On the source

  /**
   * The accounts a tenant's rows point at (a key to `users`): its members,
   * and anyone else a row of it names (a former member's grant), each with
   * the source's other tenants it also belongs to (its copy is then
   * independent of this one).
   */
  async accounts(tenantId: string) {
    const ids = new Set<string>();
    for (const { table } of tenantTables()) {
      const tenantColumn = getColumns(table).tenantId as PgColumn;
      for (const key of getTableConfig(table).foreignKeys) {
        const reference = key.reference();
        if (reference.foreignTable !== users) continue;
        const column = columnOf(table, reference.columns[0]!);
        const rows = (await this.tenancy.run(tenantId, () =>
          this.db
            .selectDistinct({ id: column })
            .from(table)
            .where(and(eq(tenantColumn, tenantId), isNotNull(column))),
        )) as { id: string }[];
        for (const row of rows) ids.add(row.id);
      }
    }
    const sorted = [...ids].sort();
    const accounts: Manifest['accounts'] = [];
    for (const part of chunks(sorted)) {
      const rows = await this.global(() =>
        this.db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.id, part))
          .orderBy(asc(users.id)),
      );
      const elsewhere = await this.global(() =>
        this.db
          .select({ userId: memberships.userId, slug: tenants.slug })
          .from(memberships)
          .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
          .where(
            and(
              inArray(memberships.userId, part),
              ne(memberships.tenantId, tenantId),
            ),
          )
          .orderBy(asc(tenants.slug)),
      );
      for (const row of rows) {
        accounts.push({
          ...row,
          elsewhere: elsewhere
            .filter((other) => other.userId === row.id)
            .map((other) => other.slug),
        });
      }
    }
    return accounts;
  }

  /**
   * Writes the archive of a frozen tenant to `out` (a new or empty
   * directory) and returns its key, shown once by the command: the key is
   * written nowhere. Every encrypted column is opened with this server's
   * keys and held in clear inside the encrypted archive; blind indexes are
   * left out (the target computes its own). Audited in no tenant (a frozen
   * tenant's own log takes no entry).
   */
  async export(actor: Principal, tenantId: string, out: string) {
    const tenant = await this.tenantOf(tenantId);
    if (!tenant.frozenAt) {
      throw new MoveRefused(
        `"${tenant.slug}" is not frozen: freeze it first (tenant:freeze ${tenant.slug}), so nothing changes while it is copied.`,
      );
    }
    await this.emptyDirectory(out);
    await mkdir(join(out, 'rows'));
    await mkdir(join(out, 'files'));
    const keyText = newArchiveKey();
    const key = archiveKey(keyText);
    const tables: TableEntry[] = [];
    const write = async (
      name: string,
      kind: TableEntry['kind'],
      table: PgTable,
      batches: AsyncIterable<Record<string, unknown>[]>,
      seen?: (row: Record<string, unknown>) => void,
    ) => {
      const path = `rows/${String(tables.length + 1).padStart(3, '0')}-${name}.ndjson`;
      const encrypted = this.encryptedOf(table);
      let rows = 0;
      const reveal = this.reveal.bind(this);
      async function* lines() {
        for await (const batch of batches) {
          for (const row of batch) {
            rows++;
            seen?.(row);
            yield Buffer.from(
              encodeRow(reveal(encrypted, writable(table, row))),
            );
          }
        }
      }
      const { bytes, sha256 } = await writeEncrypted(out, path, key, lines());
      tables.push({
        name,
        kind,
        path,
        rows,
        bytes,
        sha256,
        encrypted: encrypted.map((entry) => entry.key),
      });
    };

    await write('tenants', 'tenant', tenants, one([tenant]));
    const accounts = await this.accounts(tenantId);
    const ids = accounts.map((account) => account.id);
    await write('users', 'users', users, this.byOwner(users.id, ids));
    const accountFiles = new Set<string>();
    const named = accountFile(new Set(ids));
    for (const entry of accountRowTables()) {
      await write(
        entry.name,
        'account',
        entry.table,
        this.byOwner(entry.column, ownerValues(entry.form, ids)),
        (row) => {
          for (const value of Object.values(row)) {
            if (named(value)) accountFiles.add(value as string);
          }
        },
      );
    }
    for (const { name, table } of tenantTables()) {
      await write(name, 'rows', table, this.tenantRows(tenantId, table));
    }

    const files: FileEntry[] = [];
    const missingFiles: string[] = [];
    const copyOut = async (fileKey: string) => {
      if (!(await this.disk.exists(fileKey))) {
        missingFiles.push(fileKey);
        return;
      }
      const download = await this.disk.get(fileKey);
      const path = `files/${String(files.length + 1).padStart(6, '0')}`;
      const { bytes, sha256 } = await writeEncrypted(
        out,
        path,
        key,
        download.body,
      );
      files.push({
        key: fileKey,
        path,
        size: bytes,
        sha256,
        contentType: download.contentType,
        cacheControl: download.cacheControl,
        contentDisposition: download.contentDisposition,
        metadata: download.metadata,
      });
    };
    for await (const fileKey of this.listed(`tenants/${tenantId}/`)) {
      await copyOut(fileKey);
    }
    for (const fileKey of [...accountFiles].sort()) {
      await copyOut(fileKey);
    }

    const manifest: Manifest = {
      format: ARCHIVE_FORMAT,
      createdAt: new Date().toISOString(),
      schema: schemaVersion(),
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      tables,
      files,
      accounts,
      missingFiles,
    };
    await writeManifest(out, key, manifest);
    await this.global(() =>
      this.txHost.withTransaction(() =>
        this.audit.record(actor, {
          action: 'tenant.exported',
          targetType: 'tenant',
          targetId: tenant.id,
          details: {
            slug: tenant.slug,
            rows: tables.reduce((sum, table) => sum + table.rows, 0),
            files: files.length,
            accounts: accounts.length,
          },
        }),
      ),
    );
    return { key: keyText, manifest };
  }

  /** What `finish()` erases, for the command's question. */
  async finishing(tenantId: string) {
    const tenant = await this.tenantOf(tenantId);
    const accounts = await this.accounts(tenantId);
    return {
      tenant,
      accounts: accounts.length,
      onlyHere: await this.onlyHere(tenantId),
    };
  }

  /**
   * The tenant's members that belong to no other tenant here: once it is
   * erased, they belong to none.
   */
  private async onlyHere(tenantId: string) {
    const members = await this.global(() =>
      this.db
        .select({ id: users.id, email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.tenantId, tenantId))
        .orderBy(asc(users.email)),
    );
    const elsewhere = new Set<string>();
    for (const part of chunks(members.map((member) => member.id))) {
      const rows = await this.global(() =>
        this.db
          .selectDistinct({ userId: memberships.userId })
          .from(memberships)
          .where(
            and(
              inArray(memberships.userId, part),
              ne(memberships.tenantId, tenantId),
            ),
          ),
      );
      for (const row of rows) elsewhere.add(row.userId);
    }
    return members.filter((member) => !elsewhere.has(member.id));
  }

  /**
   * Erases a moved tenant from the source, once its import is verified on
   * the target: through TenantsService.purge() (its rows by the cascade,
   * its files released, `tenant.purged` with reason `moved`). Only a frozen
   * tenant: one thawed may have changed since its export. Accounts stay;
   * with `eraseAccounts`, those left in no tenant are then deleted through
   * personal-data's account deletion (AccountDeletionJob.deleteNow(): every
   * section's erase, their files released, legal holds respected). An
   * account still in another tenant is never deleted.
   */
  async finish(
    system: SystemPrincipal,
    tenantId: string,
    details: Record<string, unknown> = {},
    { eraseAccounts = false }: { eraseAccounts?: boolean } = {},
  ) {
    const tenant = await this.tenantOf(tenantId);
    if (!tenant.frozenAt) {
      throw new MoveRefused(
        `"${tenant.slug}" is not frozen: it may have changed since it was exported. Freeze it, export and import again, then finish.`,
      );
    }
    const candidates = await this.onlyHere(tenantId);
    const purged = await this.tenantsService.purge(
      system,
      tenantId,
      'moved',
      details,
    );
    if (!purged) {
      throw new MoveRefused("The operators' tenant is never erased.");
    }
    // Looked at again after the erase: one may have joined another tenant since.
    const left = await this.withoutTenant(
      candidates.map((account) => account.id),
    );
    const accounts = candidates.filter((account) => left.has(account.id));
    const erased: string[] = [];
    const held: string[] = [];
    if (eraseAccounts) {
      for (const account of accounts) {
        const deleted = await this.accountDeletion.deleteNow(
          system,
          account.id,
          {
            ...details,
            reason: 'tenant-moved',
            tenant: tenant.slug,
          },
        );
        (deleted ? erased : held).push(account.email);
      }
    }
    return { purged, accounts, erased, held };
  }

  /**
   * Deletes, later, an account a move left in no tenant (finish() without
   * `eraseAccounts`), through the same account deletion. Refused while it
   * belongs to any tenant. Resolves false when a legal hold keeps it.
   */
  async eraseAccount(
    system: SystemPrincipal,
    email: string,
    details: Record<string, unknown> = {},
  ) {
    const [account] = await this.global(() =>
      this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, normalizeEmail(email))),
    );
    if (!account) throw new MoveRefused(`No account ${email} here.`);
    if (!(await this.withoutTenant([account.id])).has(account.id)) {
      throw new MoveRefused(
        `${email} still belongs to a tenant here: only an account in no tenant is deleted this way.`,
      );
    }
    return this.accountDeletion.deleteNow(system, account.id, {
      ...details,
      reason: 'tenant-moved',
    });
  }

  /** Of these accounts, those that belong to no tenant. */
  private async withoutTenant(ids: string[]) {
    const left = new Set(ids);
    for (const part of chunks(ids)) {
      const rows = await this.global(() =>
        this.db
          .selectDistinct({ userId: memberships.userId })
          .from(memberships)
          .where(inArray(memberships.userId, part)),
      );
      for (const row of rows) left.delete(row.userId);
    }
    return left;
  }

  // On the target

  /**
   * The archive at `dir`, opened with its key, and what keeps it from
   * this server: a different schema, a tenant or slug already here (or,
   * with TENANCY=single, any other tenant), an address that already has an
   * account, a row it points at that is missing here. `present`: this
   * tenant is already here (an import ran before).
   */
  async inspect(dir: string, keyText: string) {
    const key = archiveKey(keyText);
    const manifest = await readManifest(dir, key).catch((error: unknown) => {
      throw error instanceof ArchiveError
        ? new MoveRefused(error.message)
        : error;
    });
    const here = schemaVersion();
    if (here.digest !== manifest.schema.digest) {
      return {
        manifest,
        key,
        present: false,
        problems: [
          `The archive is of schema ${manifest.schema.latest}, this server's is ${here.latest || 'none'}: run the same release, migrated, on both.`,
        ],
      };
    }
    const problems: string[] = [];
    const resolved = this.resolve(manifest, problems);
    const { id, slug } = manifest.tenant;
    const present = Boolean(await this.global(() => this.tenancy.find(id)));
    if (!present) {
      const [taken] = await this.global(() =>
        this.db
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.slug, slug)),
      );
      if (taken) {
        problems.push(`A tenant here already has the slug "${slug}".`);
      }
      if (this.tenancyMode.mode === 'single') {
        const [other] = await this.global(() =>
          this.db.select({ slug: tenants.slug }).from(tenants).limit(1),
        );
        if (other) {
          problems.push(
            `This deployment (TENANCY=single) already has its tenant "${other.slug}": import into a database the app has not started on (migrate, import, then start the app).`,
          );
        }
      }
    }
    const emails = manifest.accounts.map((account) => account.email);
    for (const part of chunks(emails)) {
      const found = await this.global(() =>
        this.db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(
            or(
              inArray(users.email, part),
              inArray(
                users.id,
                manifest.accounts
                  .filter((account) => part.includes(account.email))
                  .map((account) => account.id),
              ),
            ),
          ),
      );
      for (const user of found) {
        const archived = manifest.accounts.find(
          (account) => account.id === user.id || account.email === user.email,
        )!;
        if (user.id === archived.id && user.email === archived.email && present)
          continue;
        problems.push(
          user.id === archived.id
            ? `The account ${archived.email} is already here (moved with another tenant?).`
            : `${archived.email} already has an account here.`,
        );
      }
    }
    if (!present && problems.length === 0) {
      problems.push(...(await this.missingReferences(dir, key, resolved)));
    }
    return { manifest, key, present, problems };
  }

  /**
   * Puts the archive's tenant on this server and verifies it: the rows in
   * one transaction (all or nothing; encrypted columns sealed and indexed
   * with this server's keys), then the files, each read back and checked
   * against its size and checksum, then every table's count. Run again,
   * it inserts nothing: a tenant already here is verified against the
   * archive, the files it lacks are copied, and a difference is refused.
   */
  async import(actor: Principal, dir: string, keyText: string) {
    const { manifest, key, present, problems } = await this.inspect(
      dir,
      keyText,
    );
    if (problems.length > 0) {
      throw new MoveRefused(problems.join('\n'));
    }
    const resolved = this.resolve(manifest, []);
    if (present) {
      const differs = await this.countDifferences(manifest, resolved);
      if (differs.length > 0) {
        throw new MoveRefused(
          `"${manifest.tenant.slug}" is already here and differs from the archive:\n${differs.join('\n')}`,
        );
      }
    } else {
      await this.insertAll(dir, key, manifest, resolved);
    }
    const files = await this.placeFiles(dir, key, manifest);
    const differs = [
      ...(await this.countDifferences(manifest, resolved)),
      ...files.differs,
    ];
    if (differs.length > 0) {
      throw new MoveRefused(
        `The import does not match the archive:\n${differs.join('\n')}`,
      );
    }
    if (!present) {
      await this.global(() =>
        this.txHost.withTransaction(() =>
          this.audit.record(actor, {
            action: 'tenant.imported',
            targetType: 'tenant',
            targetId: manifest.tenant.id,
            details: {
              slug: manifest.tenant.slug,
              rows: manifest.tables.reduce((sum, t) => sum + t.rows, 0),
              files: manifest.files.length,
              accounts: manifest.accounts.length,
            },
          }),
        ),
      );
    }
    return { manifest, alreadyHere: present, copiedFiles: files.copied };
  }

  // Rows

  /** The archive's tables as this server declares them; a problem for one it lacks. */
  private resolve(manifest: Manifest, problems: string[]): Resolved[] {
    const rows = new Map(
      tenantTables().map((entry) => [entry.name, entry.table]),
    );
    const account = new Map(
      accountRowTables().map((entry) => [entry.name, entry.table]),
    );
    const resolved: Resolved[] = [];
    for (const entry of manifest.tables) {
      const table =
        entry.kind === 'tenant'
          ? tenants
          : entry.kind === 'users'
            ? users
            : (entry.kind === 'account' ? account : rows).get(entry.name);
      if (!table) {
        problems.push(`This server has no table ${entry.name} to put rows in.`);
        continue;
      }
      const declared = new Set(this.encryptedOf(table).map((e) => e.key));
      for (const property of entry.encrypted) {
        if (!declared.has(property)) {
          problems.push(
            `${entry.name}.${property} is encrypted, and this server declares no such encrypted column.`,
          );
        }
      }
      resolved.push({ ...entry, table });
    }
    return resolved;
  }

  /** The rows a copied row points at outside the archive (a platform's quota plan) that this server lacks. */
  private async missingReferences(
    dir: string,
    key: Buffer,
    resolved: Resolved[],
  ) {
    const inside = new Set(resolved.map((entry) => entry.table));
    const problems: string[] = [];
    for (const entry of resolved) {
      for (const reference of outsideReferences(entry.table, inside)) {
        const wanted = new Map<string, unknown[]>();
        for await (const row of readRows(dir, entry.path, key)) {
          const values = reference.properties.map((property) => row[property]);
          if (values.some((value) => value === null || value === undefined))
            continue;
          wanted.set(JSON.stringify(values), values);
        }
        for (const values of wanted.values()) {
          const [found] = await this.global(() =>
            this.db
              .select({ one: count() })
              .from(reference.table)
              .where(
                and(
                  ...reference.columns.map((column, index) =>
                    eq(column, values[index]),
                  ),
                ),
              ),
          );
          if (!found?.one) {
            problems.push(
              `${entry.name} points at ${getTableName(reference.table)} ${values.join(', ')}, which this server lacks: create it first.`,
            );
          }
        }
      }
    }
    return problems;
  }

  /** Every row, in the tenant's scope, in one transaction, each table after the ones it points at. */
  private async insertAll(
    dir: string,
    key: Buffer,
    manifest: Manifest,
    resolved: Resolved[],
  ) {
    await this.tenancy.run(manifest.tenant.id, () =>
      this.txHost.withTransaction(async () => {
        for (const entry of insertOrder(resolved)) {
          await this.insertTable(dir, key, entry).catch((error: unknown) => {
            throw refusalOf(entry.name, error);
          });
        }
      }),
    );
  }

  private async insertTable(dir: string, key: Buffer, entry: Resolved) {
    if (entry.kind === 'tenant') {
      for await (const row of readRows(dir, entry.path, key)) {
        await this.tenantsService.restore(decodeRow(tenants, row) as Tenant);
      }
      return;
    }
    const self = selfReference(entry.table);
    if (self) {
      await this.insertTree(dir, key, entry, self);
      return;
    }
    const batch = this.batcher(entry);
    for await (const row of readRows(dir, entry.path, key)) {
      await batch.add(row);
    }
    await batch.flush();
  }

  /**
   * A table whose rows point at each other (a parent): in passes, each
   * inserting the rows whose parent is in already, so no row comes before
   * its parent. The archive is read once per level, never held whole.
   */
  private async insertTree(
    dir: string,
    key: Buffer,
    entry: Resolved,
    { child, parent }: { child: string; parent: string },
  ) {
    const placed = new Set<unknown>();
    while (placed.size < entry.rows) {
      const before = placed.size;
      const level: unknown[] = [];
      const batch = this.batcher(entry);
      for await (const row of readRows(dir, entry.path, key)) {
        if (placed.has(row[parent])) continue;
        const up = row[child];
        if (up === null || up === undefined || placed.has(up)) {
          await batch.add(row);
          level.push(row[parent]);
        }
      }
      await batch.flush();
      for (const id of level) placed.add(id);
      if (placed.size === before) {
        throw new MoveRefused(
          `${entry.name}: ${entry.rows - placed.size} row(s) point at a parent the archive lacks.`,
        );
      }
    }
  }

  /** Inserts a table's rows in statements of bounded size, sealing what is encrypted. */
  private batcher(entry: Resolved) {
    const columns = Object.keys(getColumns(entry.table)).length;
    const size = Math.max(1, Math.floor(PARAMETERS / columns));
    const encrypted = this.encryptedOf(entry.table).filter((column) =>
      entry.encrypted.includes(column.key),
    );
    let rows: Record<string, unknown>[] = [];
    const flush = async () => {
      if (rows.length === 0) return;
      const values = rows;
      rows = [];
      await this.db.insert(entry.table).values(values);
    };
    return {
      add: async (row: Record<string, unknown>) => {
        rows.push(this.seal(encrypted, decodeRow(entry.table, row)));
        if (rows.length >= size) await flush();
      },
      flush,
    };
  }

  /** The table's rows per the target: a difference from the archive per line. */
  private async countDifferences(manifest: Manifest, resolved: Resolved[]) {
    const { id } = manifest.tenant;
    const ids = manifest.accounts.map((account) => account.id);
    const differs: string[] = [];
    for (const entry of resolved) {
      let rows = 0;
      if (entry.kind === 'tenant') {
        rows = await this.counted(tenants, eq(tenants.id, id));
      } else if (entry.kind === 'users') {
        for (const part of chunks(ids)) {
          rows += await this.counted(users, inArray(users.id, part));
        }
      } else if (entry.kind === 'account') {
        const declared = accountRowTables().find((a) => a.name === entry.name)!;
        for (const part of chunks(ownerValues(declared.form, ids))) {
          rows += await this.counted(
            entry.table,
            inArray(declared.column, part),
          );
        }
      } else {
        const tenantColumn = getColumns(entry.table).tenantId as PgColumn;
        rows = await this.tenancy.run(id, () =>
          this.counted(entry.table, eq(tenantColumn, id)),
        );
      }
      if (rows !== entry.rows) {
        differs.push(
          `${entry.name}: ${rows} row(s) here, ${entry.rows} in the archive.`,
        );
      }
    }
    return differs;
  }

  private async counted(table: PgTable, where: ReturnType<typeof eq>) {
    const run = async () => {
      const [row] = await this.db
        .select({ n: count() })
        .from(table)
        .where(where);
      return row?.n ?? 0;
    };
    return this.tenancy.current()?.tenantId ? run() : this.global(run);
  }

  // Files

  /**
   * Each file of the archive on this server's disk, read back and checked
   * (size and SHA-256): one already there and equal is left; one missing or
   * different is written from the archive, through the disk (local or S3),
   * streamed.
   */
  private async placeFiles(dir: string, key: Buffer, manifest: Manifest) {
    let copied = 0;
    const differs: string[] = [];
    for (const file of manifest.files) {
      if (await this.stored(file)) continue;
      await this.disk.put(file.key, readEncrypted(dir, file.path, key), {
        contentType: file.contentType,
        cacheControl: file.cacheControl,
        contentDisposition: file.contentDisposition,
        metadata: file.metadata,
        contentLength: file.size,
      });
      copied++;
      if (!(await this.stored(file))) {
        differs.push(`${file.key}: does not match the archive once written.`);
      }
    }
    return { copied, differs };
  }

  /** Whether the disk holds `file` as the archive does: its size and checksum. */
  private async stored(file: FileEntry) {
    if (!(await this.disk.exists(file.key))) return false;
    const { body } = await this.disk.get(file.key);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of body) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    return size === file.size && hash.digest('hex') === file.sha256;
  }

  // Helpers

  /** Every key under `prefix`, a page at a time. */
  private async *listed(prefix: string): AsyncIterable<string> {
    let cursor: string | undefined;
    do {
      const page = await this.disk.list({ prefix, cursor });
      for (const entry of page.entries) yield entry.key;
      cursor = page.cursor;
    } while (cursor);
  }

  /** The rows of global `table` whose `column` is one of `values`, a chunk at a time. */
  private async *byOwner(
    column: PgColumn,
    values: readonly string[],
  ): AsyncIterable<Record<string, unknown>[]> {
    const table = getColumnTable<PgTable>(column);
    const keys = pagingKey(getTableConfig(table));
    for (const part of chunks(values)) {
      yield (await this.global(() =>
        this.db
          .select()
          .from(table)
          .where(inArray(column, part))
          .orderBy(...keys.map((k) => asc(k))),
      )) as Record<string, unknown>[];
    }
  }

  /** One table's rows of the tenant, in its scope, keyset-paged (as the tenant's export pages them). */
  private async *tenantRows(
    tenantId: string,
    table: PgTable,
  ): AsyncIterable<Record<string, unknown>[]> {
    const properties = Object.entries(getColumns(table)) as [
      string,
      PgColumn,
    ][];
    const propertyOf = (column: PgColumn) =>
      properties.find(([, candidate]) => candidate === column)![0];
    const keys = pagingKey(getTableConfig(table));
    if (keys.length === 0) {
      throw new Error(`${getTableName(table)} has no key to page by.`);
    }
    const tenantColumn = getColumns(table).tenantId as PgColumn;
    let after: unknown[] | undefined;
    for (;;) {
      const rows = (await this.tenancy.run(tenantId, () =>
        this.db
          .select()
          .from(table)
          .where(
            and(
              eq(tenantColumn, tenantId),
              after ? afterKey(keys, after) : undefined,
            ),
          )
          .orderBy(...keys.map((column) => asc(column)))
          .limit(PAGE),
      )) as Record<string, unknown>[];
      if (rows.length > 0) yield rows;
      if (rows.length < PAGE) return;
      const last = rows[rows.length - 1]!;
      after = keys.map((column) => last[propertyOf(column)]);
    }
  }

  /** The encrypted columns this server declares on `table`. */
  private encryptedOf(table: PgTable): EncryptedColumn[] {
    return this.encryption.columns().filter((column) => column.table === table);
  }

  /** A row with its encrypted columns opened (this server's keys) and its blind indexes left out. */
  private reveal(encrypted: EncryptedColumn[], row: Record<string, unknown>) {
    if (encrypted.length === 0) return row;
    const open = { ...row };
    for (const column of encrypted) {
      const stored = row[column.key] as string | null | undefined;
      open[column.key] = this.encryption.decrypt(
        column.column,
        stored,
        column.tenantColumn ? (row.tenantId as string) : null,
      );
      if (column.blindIndex) delete open[column.blindIndex.key];
    }
    return open;
  }

  /** A row with its encrypted columns sealed with this server's keys, and their blind indexes computed. */
  private seal(encrypted: EncryptedColumn[], row: Record<string, unknown>) {
    for (const column of encrypted) {
      Object.assign(
        row,
        this.encryption.seal(
          column.column,
          (row[column.key] as string | null | undefined) ?? null,
          column.tenantColumn ? (row.tenantId as string) : null,
        ),
      );
    }
    return row;
  }

  /** A directory to write the archive in: made, or an empty one. */
  private async emptyDirectory(out: string) {
    try {
      await mkdir(out, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await readdir(out)).length > 0) {
        throw new MoveRefused(`${out} is not empty: name a new directory.`);
      }
    }
  }
}

/** A failed insert as the operator reads it: a conflict with a row here, or the error as it is. */
function refusalOf(table: string, error: unknown) {
  if (error instanceof MoveRefused) return error;
  if (error instanceof HttpException) {
    return new MoveRefused(`${table}: ${error.message}`);
  }
  switch (databaseErrorKind(error)) {
    case 'unique_violation':
      return new MoveRefused(
        `${table}: a row conflicts with one already here (the same id or unique value). Nothing was imported.`,
      );
    case 'foreign_key_violation':
      return new MoveRefused(
        `${table}: a row points at one this server lacks. Nothing was imported.`,
      );
    default:
      return error;
  }
}

async function* one<T>(rows: T[]): AsyncIterable<T[]> {
  yield rows;
}
