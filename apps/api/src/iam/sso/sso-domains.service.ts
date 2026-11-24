import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import type { Queue } from 'bullmq';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import { withTenant } from '../../core/tenancy/tenant-job.js';
import { AuditService } from '../audit/audit.service.js';
import type { Principal, UserPrincipal } from '../auth/principal.js';
import {
  SSO_QUEUE,
  SSO_TXT_RESOLVER,
  type SsoJob,
  type TxtResolver,
} from './sso.queue.js';
import { ssoDomainRoutes, ssoDomains } from './sso.tables.js';

/** Where the TXT record goes, under the domain. */
export const VERIFICATION_RECORD = '_sso-verification';
/** DNS answers that say the record is not there (not a lookup that failed). */
const GONE = new Set(['ENOTFOUND', 'ENODATA']);
/** What its value starts with. */
const VALUE_PREFIX = 'sso-verification=';

type Domain = typeof ssoDomains.$inferSelect;

/** The domain part of an address, lower case; undefined for anything that isn't one. */
export function emailDomain(email: string | undefined | null) {
  const at = email?.lastIndexOf('@') ?? -1;
  return at > 0 ? email!.slice(at + 1).toLowerCase() : undefined;
}

/**
 * The email domains a tenant proved it controls (README.md, "Verified
 * domains"): a TXT record `_sso-verification.<domain>` holding the value
 * the tenant was given. The lookup runs on the queue (SsoProcessor), never
 * in the request. An SSO connection may assert, and SCIM provision, only
 * addresses of these domains.
 */
@Injectable()
export class SsoDomainsService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly audit: AuditService,
    @Inject(SSO_TXT_RESOLVER) private readonly dns: TxtResolver,
    @InjectQueue(SSO_QUEUE) private readonly queue: Queue<SsoJob>,
  ) {}

  async list() {
    const rows = await this.db
      .select()
      .from(ssoDomains)
      .orderBy(asc(ssoDomains.domain));
    return rows.map(view);
  }

  /** Adds a domain to verify: the record to publish, then POST …/verify. */
  async create(actor: UserPrincipal, domain: string, ip?: string) {
    const row = await this.txHost.withTransaction(async () => {
      const [created] = await this.db
        .insert(ssoDomains)
        .values({
          domain,
          verificationToken: `${VALUE_PREFIX}${randomBytes(24).toString('base64url')}`,
        })
        .returning()
        .catch((error: unknown) => {
          throw databaseErrorKind(error) === 'unique_violation'
            ? new ConflictException({
                code: 'sso_domain_exists',
                message: `${domain} is listed already.`,
                errors: [{ path: 'domain', message: 'Listed already.' }],
              })
            : error;
        });
      await this.audit.record(actor, {
        action: 'sso.domain-added',
        targetType: 'sso-domain',
        targetId: created.id,
        details: { domain },
        ip,
      });
      return created;
    });
    return view(row);
  }

  async remove(actor: UserPrincipal, id: string, ip?: string) {
    await this.txHost.withTransaction(async () => {
      const [row] = await this.db
        .delete(ssoDomains)
        .where(eq(ssoDomains.id, id))
        .returning();
      if (!row) {
        throw notFound(id);
      }
      // Global: filtered by the tenant here (no row-level security).
      await this.db
        .delete(ssoDomainRoutes)
        .where(
          and(
            eq(ssoDomainRoutes.domain, row.domain),
            eq(ssoDomainRoutes.tenantId, row.tenantId),
          ),
        );
      await this.audit.record(actor, {
        action: 'sso.domain-removed',
        targetType: 'sso-domain',
        targetId: id,
        details: { domain: row.domain },
        ip,
      });
    });
  }

  /** Queues the DNS check (202). */
  async requestVerification(id: string) {
    await this.find(id);
    await this.queue.add(
      'domain-verification',
      withTenant({ kind: 'domain-verification' as const, domainId: id }),
    );
  }

  /**
   * The job's work: looks the TXT record up and records the outcome. A
   * verified domain whose record is gone (the domain changed hands: the DNS
   * says so, ENOTFOUND or ENODATA, or holds another value) is verified no
   * more, and its route goes; a lookup that failed records only the error.
   */
  async verify(actor: Principal, id: string) {
    const [row] = await this.db
      .select()
      .from(ssoDomains)
      .where(eq(ssoDomains.id, id));
    if (!row) {
      return;
    }
    let outcome: 'found' | 'gone' | 'failed';
    let error: string | null = null;
    try {
      const records = await this.dns.resolveTxt(
        `${VERIFICATION_RECORD}.${row.domain}`,
      );
      outcome = records.some(
        (chunks) => chunks.join('') === row.verificationToken,
      )
        ? 'found'
        : 'gone';
      if (outcome === 'gone') {
        error = 'The TXT record was not found or holds another value.';
      }
    } catch (failure) {
      const code = (failure as { code?: string }).code;
      outcome = code && GONE.has(code) ? 'gone' : 'failed';
      error = `DNS lookup failed: ${code ?? (failure as Error).message}`;
    }
    const now = new Date();
    await this.txHost.withTransaction(async () => {
      // Locked and read again: a domain removed while the lookup ran must
      // not get its route back.
      const [current] = await this.db
        .select({ verifiedAt: ssoDomains.verifiedAt })
        .from(ssoDomains)
        .where(eq(ssoDomains.id, id))
        .for('update');
      if (!current) {
        return;
      }
      const was = current.verifiedAt !== null;
      const verified =
        outcome === 'found' ? true : outcome === 'gone' ? false : was;
      await this.db
        .update(ssoDomains)
        .set({
          lastCheckedAt: now,
          lastError: error,
          verifiedAt: verified ? (current.verifiedAt ?? now) : null,
        })
        .where(eq(ssoDomains.id, id));
      if (outcome === 'found') {
        // The sign-in page's lookup (global; kept with the verification).
        await this.db
          .insert(ssoDomainRoutes)
          .values({ domain: row.domain, tenantId: row.tenantId })
          .onConflictDoNothing();
      } else if (outcome === 'gone') {
        await this.db
          .delete(ssoDomainRoutes)
          .where(
            and(
              eq(ssoDomainRoutes.domain, row.domain),
              eq(ssoDomainRoutes.tenantId, row.tenantId),
            ),
          );
      }
      if (verified !== was) {
        await this.audit.record(actor, {
          action: verified ? 'sso.domain-verified' : 'sso.domain-suspended',
          targetType: 'sso-domain',
          targetId: id,
          details: { domain: row.domain },
        });
      }
    });
  }

  /** The current tenant's verified domains: what the nightly check looks up again. */
  async verifiedIds() {
    const rows = await this.db
      .select({ id: ssoDomains.id })
      .from(ssoDomains)
      .where(isNotNull(ssoDomains.verifiedAt));
    return rows.map((row) => row.id);
  }

  /** The tenants that route a domain (global): whose domains the nightly check walks. */
  async routedTenants() {
    const rows = await this.db
      .selectDistinct({ tenantId: ssoDomainRoutes.tenantId })
      .from(ssoDomainRoutes);
    return rows.map((row) => row.tenantId);
  }

  /** Whether the current tenant verified `domain`. */
  async isVerified(domain: string | undefined) {
    if (!domain) {
      return false;
    }
    const [row] = await this.db
      .select({ id: ssoDomains.id })
      .from(ssoDomains)
      .where(
        and(eq(ssoDomains.domain, domain), isNotNull(ssoDomains.verifiedAt)),
      );
    return !!row;
  }

  private async find(id: string) {
    const [row] = await this.db
      .select()
      .from(ssoDomains)
      .where(eq(ssoDomains.id, id));
    if (!row) {
      throw notFound(id);
    }
    return row;
  }
}

function view(row: Domain) {
  return {
    id: row.id,
    domain: row.domain,
    verified: row.verifiedAt !== null,
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    record: {
      type: 'TXT' as const,
      name: `${VERIFICATION_RECORD}.${row.domain}`,
      value: row.verificationToken,
    },
    createdAt: row.createdAt,
  };
}

const notFound = (id: string) =>
  new NotFoundException(`Domain ${id} not found.`);
