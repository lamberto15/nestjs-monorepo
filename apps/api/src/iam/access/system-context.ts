import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { type SystemPrincipal, systemPrincipal } from '../auth/principal.js';
import { PermissionCatalog } from './permission-catalog.js';
import type { SystemJobDefinition } from './permissions.js';

/**
 * The CLS key of the system principal the current context runs as. A
 * symbol: a dotted string key is a path in nestjs-cls, whose parent object
 * a nested (`inherit`) context shares, so an inner job would leak out.
 */
const SYSTEM = Symbol('access.system');

/** How `SystemContext.run()` runs the work. */
export interface SystemRunOptions {
  /**
   * `true` (the default): the work is one transaction (joining the current
   * one). `false`: none is opened, for a batch job that commits in short
   * transactions of its own, each still in the context.
   */
  transaction?: boolean;
  /**
   * The tenant the job works for: its queries are bound to it. `null`: no
   * tenant (global tables only). Left out: the current context's.
   */
  tenantId?: string | null;
}

/**
 * Runs work as the system principal (README.md, "The system principal"):
 * what seeds, scheduled jobs and workflow steps do without a user. One way
 * in, so every such job has the same actor (`system:<job>` in the audit
 * log), the permissions its declaration gives (`defineSystemJob()` in a
 * module's `AccessModule.forFeature()`, nothing implicit), and a CLS
 * context of its own, with the tenant it works for.
 *
 * ```ts
 * run() {
 *   return this.system.run(ACCOUNT_DELETION_JOB, async (system) => {
 *     await this.audit.record(system, { action: 'account.deleted', … });
 *   }, { tenantId });
 * }
 * ```
 */
@Injectable()
export class SystemContext {
  constructor(
    private readonly cls: ClsService,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly catalog: PermissionCatalog,
    private readonly tenancy: Tenancy,
  ) {}

  /** The system principal of a declared job; throws for one no declaration has. */
  principal(job: SystemJobDefinition | string): SystemPrincipal {
    const key = typeof job === 'string' ? job : job.key;
    if (!this.catalog.systemJob(key)) {
      throw new Error(
        `System job "${key}" isn't declared: list it in a definePermissions({ systemJobs }) registered with AccessModule.forFeature().`,
      );
    }
    return systemPrincipal({ key, label: this.catalog.jobLabel(key) });
  }

  /**
   * Runs `work` as the job's system principal, in a CLS context carrying
   * it (`current()`), in one transaction unless `{ transaction: false }`.
   * Nested runs see the inner job; the outer context is left as it was.
   */
  async run<T>(
    job: SystemJobDefinition | string,
    work: (system: SystemPrincipal) => Promise<T>,
    { transaction = true, tenantId }: SystemRunOptions = {},
  ): Promise<T> {
    const system = this.principal(job);
    const inContext = () =>
      this.cls.run({ ifNested: 'inherit' }, async () => {
        this.cls.set(SYSTEM, system);
        return transaction
          ? await this.txHost.withTransaction(() => work(system))
          : await work(system);
      });
    // Tenancy.run: a context of its own with the tenant, refused inside an
    // open transaction of another tenant.
    return tenantId === undefined
      ? inContext()
      : this.tenancy.run(tenantId, inContext);
  }

  /** The system principal the current context runs as (inside `run()`), or undefined. */
  current(): SystemPrincipal | undefined {
    return this.cls.isActive()
      ? (this.cls.get(SYSTEM) as SystemPrincipal | undefined)
      : undefined;
  }
}
