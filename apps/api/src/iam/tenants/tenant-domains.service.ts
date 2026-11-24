import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { TransactionHost } from '@nestjs-cls/transactional';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { ConfigType } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { httpConfig } from '../../core/http/http.config.js';
import { REDIS } from '../../core/redis/redis.js';
import { withTenant } from '../../core/tenancy/tenant-job.js';
import { AuditService } from '../audit/audit.service.js';
import { discoverOne } from '../auth/discover.js';
import { HostTenantResolver, type HostTenants } from '../auth/host-tenant.js';
import type { Principal } from '../auth/principal.js';
import {
  DomainChangeGuard,
  type DomainChangeGuarded,
} from './domain-change-guard.js';
import { normalizeHostname } from './hostname.js';
import { tenantsConfig } from './tenants.config.js';
import { TenantDomainsRepository } from './tenant-domains.repository.js';
import type { TenantDomain } from './tenants.tables.js';

/** Where the TXT record goes, under the hostname. */
export const DOMAIN_VERIFICATION_RECORD = '_app-verification';
const VALUE_PREFIX = 'app-verification=';

/** The queue of the DNS checks: a lookup on a tenant's word never runs in a request. */
export const TENANT_DOMAINS_QUEUE = 'tenant-domains';
export interface DomainCheckJob {
  domainId: string;
}

/** Looks up TXT records: node's resolver, replaced in tests. */
export const TXT_RESOLVER = Symbol('tenant-domains.txt-resolver');
export type TxtResolver = (name: string) => Promise<string[][]>;
export const systemTxtResolver: TxtResolver = (name) => resolveTxt(name);

/** DNS answers that say the record is not there (not a lookup that failed). */
const GONE = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * A hostname no tenant routes, remembered in Redis for 30 s: a flood of
 * requests for one unknown name reads the database once. Only the absence
 * is cached, so a removed domain stops at once.
 */
const UNKNOWN_HOST_SECONDS = 30;
const unknownHostKey = (hostname: string) =>
  `tenant-domains:unknown:${hostname}`;

/**
 * A tenant's own domains: a hostname its people reach the app on, proved
 * by a TXT record `_app-verification.<hostname>` holding the value the
 * tenant was given, and verified only while it resolves (checked on the
 * queue when asked, and every night). A verified hostname routes to its
 * tenant (`tenant_domain_routes`): SessionAuth asks `tenantOfHost()`
 * (this provider is the `@HostTenantResolver()`), and a session on that
 * host acts in that tenant only. Off unless CUSTOM_DOMAINS=on.
 */
@Injectable()
@HostTenantResolver()
export class TenantDomainsService implements HostTenants, OnModuleInit {
  private guard?: DomainChangeGuarded;

  constructor(
    private readonly repository: TenantDomainsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly audit: AuditService,
    @Inject(tenantsConfig.KEY)
    private readonly config: ConfigType<typeof tenantsConfig>,
    @Inject(httpConfig.KEY)
    private readonly http: ConfigType<typeof httpConfig>,
    @Inject(TXT_RESOLVER) private readonly dns: TxtResolver,
    @InjectQueue(TENANT_DOMAINS_QUEUE)
    private readonly queue: Queue<DomainCheckJob>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly discovery: DiscoveryService,
  ) {}

  onModuleInit() {
    this.guard = discoverOne<DomainChangeGuarded>(
      this.discovery,
      DomainChangeGuard,
      'domain change guard (@DomainChangeGuard())',
    );
  }

  get enabled() {
    return this.config.customDomains;
  }

  /** The deployment's own host: never a tenant's domain. */
  private appHosts() {
    return [new URL(this.http.appUrl).hostname];
  }

  async list() {
    const rows = await this.repository.list();
    return { enabled: this.enabled, items: rows.map(view) };
  }

  /** Adds a hostname to prove: the record to publish, then POST …/verify. */
  async create(actor: Principal, input: string, ip?: string) {
    this.assertEnabled();
    await this.guard?.assertEditable(actor);
    const checked = normalizeHostname(input, this.appHosts());
    if ('refused' in checked) {
      const message = t(`tenants.hostname.${checked.refused}`);
      throw new BadRequestException({
        code: 'invalid_hostname',
        message,
        errors: [{ path: 'hostname', message }],
      });
    }
    const { hostname } = checked;
    return this.txHost.withTransaction(async () => {
      const created = await this.repository
        .insert({
          hostname,
          verificationToken: `${VALUE_PREFIX}${randomBytes(24).toString('base64url')}`,
        })
        .catch((error: unknown) => {
          throw databaseErrorKind(error) === 'unique_violation'
            ? new ConflictException({
                code: 'domain_exists',
                message: t('tenants.domainExists', { args: { hostname } }),
                errors: [
                  { path: 'hostname', message: t('tenants.domainExistsField') },
                ],
              })
            : error;
        });
      await this.audit.record(actor, {
        action: 'tenant.domain-added',
        targetType: 'tenant-domain',
        targetId: created.id,
        details: { hostname },
        ip,
      });
      return view(created);
    });
  }

  /**
   * Removes a domain and its route in one transaction: from the commit on,
   * the host has no tenant. Allowed with CUSTOM_DOMAINS off too: taking a
   * hostname away only narrows what is served.
   */
  async remove(actor: Principal, id: string, ip?: string) {
    await this.txHost.withTransaction(async () => {
      const row = await this.repository.delete(id);
      if (!row) {
        throw notFound();
      }
      // Global: narrowed to the tenant here (no row-level security).
      await this.repository.unroute(row.hostname, row.tenantId);
      await this.audit.record(actor, {
        action: 'tenant.domain-removed',
        targetType: 'tenant-domain',
        targetId: id,
        details: { hostname: row.hostname },
        ip,
      });
    });
  }

  /** Queues the DNS check (202). */
  async requestVerification(actor: Principal, id: string) {
    this.assertEnabled();
    await this.guard?.assertEditable(actor);
    await this.find(id);
    // A second click while the check is pending queues nothing more; once
    // it ran, a new request checks again (BullMQ's simple deduplication).
    await this.queue.add('verify', withTenant({ domainId: id }), {
      deduplication: { id: `verify:${id}` },
    });
  }

  /**
   * The check: looks the TXT record up and records the outcome. Found:
   * verified, and routed unless another tenant routes the hostname already
   * (the first to prove it keeps it until its own record goes). Gone: no
   * longer verified, the route goes. A lookup that failed (a timeout)
   * changes nothing but the error: a DNS outage takes no domain away.
   */
  async verify(actor: Principal, id: string) {
    const row = await this.repository.findById(id);
    if (!row) {
      return;
    }
    let outcome: 'found' | 'gone' | 'failed';
    let error: string | null = null;
    try {
      const records = await this.dns(
        `${DOMAIN_VERIFICATION_RECORD}.${row.hostname}`,
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
    const routed = await this.txHost.withTransaction(async () => {
      // Locked and read again: a domain removed while the lookup ran must
      // not get its route back.
      const current = await this.repository.lockVerification(id);
      if (!current) {
        return false;
      }
      let verified = current.verifiedAt !== null;
      if (outcome === 'found') {
        verified =
          (await this.repository.route(row.hostname, row.tenantId)) ===
          row.tenantId;
        if (!verified) {
          error = 'Another tenant uses this domain.';
        }
      } else if (outcome === 'gone') {
        verified = false;
        await this.repository.unroute(row.hostname, row.tenantId);
      }
      await this.repository.recordCheck(id, {
        lastCheckedAt: new Date(),
        lastError: error,
        verifiedAt: verified ? (current.verifiedAt ?? new Date()) : null,
      });
      if (verified !== (current.verifiedAt !== null)) {
        await this.audit.record(actor, {
          action: verified
            ? 'tenant.domain-verified'
            : 'tenant.domain-suspended',
          targetType: 'tenant-domain',
          targetId: id,
          details: { hostname: row.hostname },
        });
      }
      return verified;
    });
    if (routed) {
      await this.redis.del(unknownHostKey(row.hostname)).catch(() => 0);
    }
  }

  /** The current tenant's verified domains: what the nightly check looks up again. */
  async verifiedIds() {
    return this.repository.verifiedIds();
  }

  /** The tenants that route a hostname (global): whose domains the nightly check walks. */
  async routedTenants() {
    return this.repository.routedTenantIds();
  }

  /**
   * The active tenant whose verified domain `hostname` is, or null:
   * CUSTOM_DOMAINS off, the app's own host, a name that could never be a
   * domain of a tenant (an IP, `localhost`), or one nobody verified. Only
   * a hostname nobody routes is cached; Redis unreachable, the database
   * answers.
   */
  async tenantOfHost(hostname: string): Promise<string | null> {
    if (!this.enabled) {
      return null;
    }
    const checked = normalizeHostname(hostname, this.appHosts());
    if ('refused' in checked) {
      return null;
    }
    const key = unknownHostKey(checked.hostname);
    if (await this.redis.exists(key).catch(() => 0)) {
      return null;
    }
    const route = await this.repository.activeTenantOf(checked.hostname);
    if (!route) {
      await this.redis
        .set(key, '1', 'EX', UNKNOWN_HOST_SECONDS)
        .catch(() => undefined);
      return null;
    }
    return route;
  }

  private assertEnabled() {
    if (!this.enabled) {
      throw new NotFoundException({
        code: 'feature_off',
        message: t('auth.featureOff', { args: { name: 'CUSTOM_DOMAINS' } }),
      });
    }
  }

  private async find(id: string) {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound();
    }
    return row;
  }
}

function view(row: TenantDomain) {
  return {
    id: row.id,
    hostname: row.hostname,
    verified: row.verifiedAt !== null,
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    record: {
      type: 'TXT' as const,
      name: `${DOMAIN_VERIFICATION_RECORD}.${row.hostname}`,
      value: row.verificationToken,
    },
    createdAt: row.createdAt,
  };
}

const notFound = () => new NotFoundException(t('tenants.domainNotFound'));
