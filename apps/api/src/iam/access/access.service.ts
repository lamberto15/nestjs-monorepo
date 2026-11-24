import { randomUUID } from 'node:crypto';
import {
  AbilityBuilder,
  createMongoAbility,
  type MongoAbility,
  subject as asSubject,
} from '@casl/ability';
import { permittedFieldsOf } from '@casl/ability/extra';
import {
  ForbiddenException,
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { RolesRepository } from './roles.repository.js';
import {
  type ListQuery,
  queryMatches,
  queryReads,
} from '../../core/http/list-query.js';
import { closeRedis, REDIS } from '../../core/redis/redis.js';
import { currentTenantScope } from '../../core/tenancy/tenant-scope.js';
import { discoverOne } from '../auth/discover.js';
import {
  isSystemPrincipal,
  type Principal,
  principalKey,
} from '../auth/principal.js';
import { ACCESS_EVENTS, type AbilitiesChangedEvent } from './access.events.js';
import {
  type FieldComparison,
  PermissionCatalog,
} from './permission-catalog.js';
import {
  type AccessContext,
  isAll,
  NO_UNITS,
  type PermissionInput,
} from './permissions.js';
import { UnitDirectory } from './unit-directory.js';

/*
 * The one file that knows CASL (@casl/ability): it is the in-memory rules
 * engine behind AccessService. Everything else asks AccessService, or a
 * policy (@nestjs/authorization) that asks it.
 */

type AppAbility = MongoAbility;

/** The field a permission with `fields: []` grants: none that exists. */
const NO_FIELDS = '$none';

/**
 * A permission's comparisons as one CASL condition, keyed by the record's
 * field names: each field must hold one of its values. Two comparisons of
 * one field narrow it (the lists intersect), as SQL's AND does.
 */
export function caslCondition(comparisons: readonly FieldComparison[]) {
  const values = new Map<string, readonly unknown[]>();
  for (const { field, values: allowed } of comparisons) {
    const current = values.get(field);
    values.set(
      field,
      current
        ? current.filter((value) => allowed.includes(value as string))
        : allowed,
    );
  }
  return Object.fromEntries(
    [...values].map(([field, allowed]) => [field, { $in: [...allowed] }]),
  );
}

/** The same comparisons as SQL: every column holds one of its values; none to hold matches nothing. */
export function sqlCondition(comparisons: readonly FieldComparison[]): SQL {
  return (
    and(
      ...comparisons.map(({ column, values }) =>
        values.length === 0
          ? sql`false`
          : values.length === 1
            ? eq(column, values[0])
            : inArray(column, [...values]),
      ),
    ) ?? sql`true`
  );
}

/**
 * The CASL ability of these permissions for this principal and context:
 * what `can()` asks. A permission with an undeclared condition grants
 * nothing.
 */
export function abilityOf(
  catalog: PermissionCatalog,
  principal: Principal,
  permissions: readonly PermissionInput[],
  context: AccessContext,
): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const permission of permissions) {
    if (isAll(permission)) {
      can('manage', 'all');
      continue;
    }
    const comparisons = catalog.comparisons(principal, permission, context);
    if (!comparisons) continue;
    // [] (none of the restrictable fields) still has to restrict: CASL reads [] as "all".
    const fields = permission.fields
      ? permission.fields.length
        ? permission.fields
        : [NO_FIELDS]
      : undefined;
    const conditions = comparisons.length
      ? caslCondition(comparisons)
      : undefined;
    if (conditions) {
      can(permission.action, permission.subject, fields, conditions);
    } else if (fields) {
      can(permission.action, permission.subject, fields);
    } else {
      can(permission.action, permission.subject);
    }
  }
  return build();
}

/**
 * The SQL filter of the rows of `subject` these permissions let the
 * principal `action`: `undefined` for all of them, else a condition
 * (`false` for none). Derived from the same comparisons as abilityOf().
 */
export function filterOf(
  catalog: PermissionCatalog,
  principal: Principal,
  permissions: readonly PermissionInput[],
  subject: string,
  action: string,
  context: AccessContext,
): SQL | undefined {
  const filters: SQL[] = [];
  for (const permission of permissions) {
    if (
      !isAll(permission) &&
      (permission.subject !== subject || permission.action !== action)
    ) {
      continue;
    }
    const comparisons = isAll(permission)
      ? []
      : catalog.comparisons(principal, permission, context);
    if (!comparisons) continue;
    if (comparisons.length === 0) return undefined;
    filters.push(sqlCondition(comparisons));
  }
  return filters.length ? or(...filters) : sql`false`;
}

/**
 * Whether `field`, which some rule lets `action` reach, is hidden on some
 * of the records `action` reaches: what a filter, a sort or a search on it
 * would reveal. CASL's `can(action, subject, field)` on a subject type is
 * true as soon as one rule grants the field, conditions or not, so the
 * rules are read: a grant without conditions shows it everywhere; a
 * forbidding rule with conditions hides it somewhere; otherwise every rule
 * of `reach` (the action whose rows the query matches: `restore` for the
 * recycle bin, a bulk run's) must have a grant of the field with the same
 * conditions.
 */
export function hiddenOnSomeRecords(
  ability: AppAbility,
  action: string,
  subject: string,
  field: string,
  reach: string = action,
): boolean {
  const rules = ability.rulesFor(action, subject, field);
  for (const rule of rules) {
    if (!rule.inverted && !rule.conditions) {
      return false;
    }
    if (rule.inverted && rule.fields && rule.conditions) {
      return true;
    }
  }
  const granted = new Set(
    rules
      .filter((rule) => !rule.inverted)
      .map((rule) => JSON.stringify(rule.conditions)),
  );
  return ability
    .possibleRulesFor(reach, subject)
    .some(
      (rule) => !rule.inverted && !granted.has(JSON.stringify(rule.conditions)),
    );
}

/** A permission a principal holds, and the grant it holds it by (`explain()`). */
export interface HeldPermission {
  permission: PermissionInput;
  /** The role granted, or null: an API client's `clientPermissions`, a system job's. */
  roleId: string | null;
  /** When the grant ends, or null for never. */
  expiresAt: Date | null;
}

/**
 * Why a principal may or may not act on a subject, or on one of its
 * records (`explain()`). A `null` is withheld: the answer depends on a
 * field the asker may not read on the record.
 */
export interface Explanation {
  held: HeldPermission[];
  context: AccessContext;
  actions: {
    action: string;
    allowed: boolean | null;
    fields: string[] | null;
    grants: {
      index: number;
      matches: boolean | null;
      conditions: { key: string; matches: boolean | null }[];
    }[];
  }[];
}

/**
 * An invalidation as published: `{ from, tenantId }`. Anything else (an
 * instance of the release before, which published its id alone) drops
 * every tenant's.
 */
export function parseInvalidation(message: string): {
  from: string;
  tenantId: string | null;
} {
  try {
    const { from, tenantId } = JSON.parse(message) as {
      from?: unknown;
      tenantId?: unknown;
    };
    if (typeof from === 'string') {
      return { from, tenantId: typeof tenantId === 'string' ? tenantId : null };
    }
  } catch {
    // Not JSON: the older message.
  }
  return { from: message, tenantId: null };
}

interface Loaded {
  /** The generation it was built in (`generation()`): a load that raced an invalidation is not cached. */
  version: string;
  permissions: PermissionInput[];
  context: AccessContext;
  ability: AppAbility;
}

/**
 * "May this principal do this?" (README.md). A user's permissions come
 * from their unexpired role grants in the request's tenant; an API
 * client's from what every client may do (`clientPermissions`) and its
 * own grants; the system principal's from its job's declaration, nothing
 * more. Abilities are cached per tenant and principal, for a minute at
 * most and never past a grant's end or a unit membership's start or end;
 * `invalidate(tenantId)` drops that tenant's, here and on every instance
 * (Redis pub/sub), so a change applies from the next request.
 */
@Injectable()
export class AccessService implements OnModuleInit, OnApplicationShutdown {
  private static readonly MAX_AGE_MS = 60_000;
  /** The most abilities kept on an instance (tenants × principals seen within a minute). */
  static readonly MAX_ENTRIES = 10_000;
  /** Bumped by a full clear; a tenant's own counter by an invalidation of that tenant. */
  private version = 0;
  private readonly tenantVersions = new Map<string, number>();
  /** This instance, so it ignores its own invalidations coming back. */
  private readonly instanceId = randomUUID();
  private subscriber?: Redis;
  private readonly cache = new Map<string, { loaded: Loaded; until: number }>();
  /** The loads under way, by version and key: concurrent misses share one. */
  private readonly loading = new Map<string, Promise<Loaded>>();
  private units?: UnitDirectory;

  constructor(
    private readonly repository: RolesRepository,
    private readonly catalog: PermissionCatalog,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly discovery: DiscoveryService,
    private readonly events: EventEmitter2,
  ) {}

  /** Pub/sub channels ignore ioredis' key prefix: the prefix goes into the name. */
  private get channel() {
    return `${this.redis.options.keyPrefix ?? ''}access:invalidate`;
  }

  async onModuleInit() {
    this.units = discoverOne<UnitDirectory>(
      this.discovery,
      UnitDirectory,
      'unit directory (@UnitDirectory())',
    );
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('message', (_channel: string, message: string) => {
      const { from, tenantId } = parseInvalidation(message);
      if (from !== this.instanceId) this.clear(tenantId);
    });
    await this.subscriber.subscribe(this.channel);
  }

  async onApplicationShutdown() {
    if (this.subscriber) await closeRedis(this.subscriber);
  }

  /**
   * Drops the cached abilities of `tenantId`, here and on every other
   * instance: call after any change to that tenant's roles, grants or unit
   * memberships. `null` drops every tenant's, for a change that is not one
   * tenant's (roles, grants and units are all tenant tables, so none today).
   */
  invalidate(tenantId: string | null) {
    this.clear(tenantId);
    void this.redis
      .publish(
        this.channel,
        JSON.stringify({ from: this.instanceId, tenantId }),
      )
      .catch(() => undefined);
  }

  /** The generation of a tenant's abilities (`-` for none): what a cached one must still be of. */
  private generation(tenant: string) {
    return `${this.version}.${this.tenantVersions.get(tenant) ?? 0}`;
  }

  /**
   * Room for one more ability: past MAX_ENTRIES the expired go, then the
   * oldest (a Map keeps insertion order). Otherwise entries only ever left
   * on an invalidation, and a quiet instance serving many principals grew
   * without bound. Custom: a few lines on the Map, where an LRU package
   * (or @nestjs/cache-manager's asynchronous store) would sit on every
   * permission check.
   */
  private makeRoom() {
    if (this.cache.size < AccessService.MAX_ENTRIES) return;
    // Only the expired: an invalidation deletes what it makes stale.
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.until <= now) this.cache.delete(key);
    }
    for (const key of this.cache.keys()) {
      if (this.cache.size < AccessService.MAX_ENTRIES) break;
      this.cache.delete(key);
    }
  }

  /** Both paths of an invalidation (this instance's, another's by pub/sub) end here. */
  private clear(tenantId: string | null) {
    if (tenantId === null) {
      this.version++;
      this.tenantVersions.clear();
      this.cache.clear();
    } else {
      this.tenantVersions.set(
        tenantId,
        (this.tenantVersions.get(tenantId) ?? 0) + 1,
      );
      // Keys lead with the tenant (load()): one pass over at most MAX_ENTRIES.
      const prefix = `${tenantId}:`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) this.cache.delete(key);
      }
    }
    this.events.emit(ACCESS_EVENTS.abilitiesChanged, {
      tenantId,
    } satisfies AbilitiesChangedEvent);
  }

  /** Whether the principal may do `action` on `subject`: on this record, or on some when there is none. */
  async can(
    principal: Principal | null,
    action: string,
    subject: string,
    record?: Record<string, unknown>,
  ): Promise<boolean> {
    if (!principal) return false;
    const { ability } = await this.load(principal);
    return this.decide(ability, action, subject, record);
  }

  /** The principal's permissions, as stored (an administrator's is ALL). */
  async permissions(principal: Principal): Promise<PermissionInput[]> {
    return (await this.load(principal)).permissions;
  }

  /**
   * The SQL filter of the records of `subject` this principal may
   * `action`: `undefined` for all of them, or a condition (`false` for
   * none). Lists filter in the query; one record is checked with `can()`.
   * A soft-deletable subject's live rows only, or with `deleted` its
   * recycle bin.
   */
  async sqlFilter(
    principal: Principal,
    subject: string,
    action: string,
    { deleted = false }: { deleted?: boolean } = {},
  ): Promise<SQL | undefined> {
    const { permissions, context } = await this.load(principal);
    const permitted = filterOf(
      this.catalog,
      principal,
      permissions,
      subject,
      action,
      context,
    );
    const deletedAt = this.catalog.deletedAt(subject);
    if (!deletedAt) return permitted;
    // Deleted rows never reach a list, a count or an export, whatever the filter says.
    const state = deleted ? isNotNull(deletedAt) : isNull(deletedAt);
    return permitted ? and(permitted, state) : state;
  }

  /**
   * The record without the declared fields the principal may not `action`
   * (field-level permissions): what a response may show. Undeclared fields
   * are always kept.
   */
  async redact<T extends Record<string, unknown>>(
    principal: Principal,
    action: string,
    subject: string,
    record: T,
  ): Promise<Partial<T>> {
    const declared = this.catalog.declaredFields(subject);
    if (declared.length === 0) return record;
    const { ability } = await this.load(principal);
    const allowed = new Set(
      this.permittedFields(ability, action, subject, record),
    );
    return Object.fromEntries(
      Object.entries(record).filter(
        ([field]) => !declared.includes(field) || allowed.has(field),
      ),
    ) as Partial<T>;
  }

  /** `redact()` for each record of a list. */
  redactAll<T extends Record<string, unknown>>(
    principal: Principal,
    action: string,
    subject: string,
    records: T[],
  ) {
    return Promise.all(
      records.map((record) => this.redact(principal, action, subject, record)),
    );
  }

  /** The declared fields among `changes` the principal may not `action` on this record: a write answers 403. */
  async forbiddenFields(
    principal: Principal,
    action: string,
    subject: string,
    changes: Record<string, unknown>,
    record?: Record<string, unknown>,
  ): Promise<string[]> {
    const declared = this.catalog.declaredFields(subject);
    const touched = Object.keys(changes).filter(
      (field) => declared.includes(field) && changes[field] !== undefined,
    );
    if (touched.length === 0) return [];
    const { ability } = await this.load(principal);
    const target = record ? asSubject(subject, { ...record }) : subject;
    return touched.filter((field) => !ability.can(action, target, field));
  }

  /**
   * The declared fields of `subject` the principal may `action` on no
   * record at all: what a description of the subject leaves out.
   */
  async deniedFields(
    principal: Principal,
    action: string,
    subject: string,
  ): Promise<string[]> {
    const declared = this.catalog.declaredFields(subject);
    if (declared.length === 0) return [];
    const { ability } = await this.load(principal);
    const permitted = this.permittedFields(ability, action, subject);
    return declared.filter((field) => !permitted.includes(field));
  }

  /**
   * The declared fields of `subject` the principal may `action` on some of
   * the records they may `action` only (hiddenOnSomeRecords()): a query
   * filtering, searching or sorting by one would tell its value where
   * `redact()` hides it.
   */
  async conditionalFields(
    principal: Principal,
    action: string,
    subject: string,
    reach: string = action,
  ): Promise<string[]> {
    const declared = this.catalog.declaredFields(subject);
    if (declared.length === 0) return [];
    const { ability } = await this.load(principal);
    return declared.filter(
      (field) =>
        ability.can(action, subject, field) &&
        hiddenOnSomeRecords(ability, action, subject, field, reach),
    );
  }

  /**
   * A 403 `field_forbidden` when a validated list query uses a field
   * `deniedFields()` hides (to filter, search, sort or select by), or
   * filters, searches or sorts by one `conditionalFields()` shows on some
   * records only. Every list of a subject with declared fields calls it
   * after validating the query. `reach`: the action whose rows the query
   * matches (`sqlFilter()`'s), when not `read`.
   */
  async assertQueryFields(
    principal: Principal,
    subject: string,
    query: ListQuery,
    { reach = 'read' }: { reach?: string } = {},
  ): Promise<void> {
    if (this.catalog.declaredFields(subject).length === 0) return;
    const reads = queryReads(query);
    if (reads.length === 0) return;
    const matching = queryMatches(query);
    const [denied, conditional] = await Promise.all([
      this.deniedFields(principal, 'read', subject),
      this.conditionalFields(principal, 'read', subject, reach),
    ]);
    const forbidden = reads.filter(
      (field) =>
        denied.includes(field) ||
        (conditional.includes(field) && matching.includes(field)),
    );
    if (forbidden.length) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `You may not filter, search, sort or select by: ${forbidden.join(', ')}.`,
        fields: forbidden,
      });
    }
  }

  /**
   * Why `principal` may or may not do each of `actions` on `subject` (on
   * `record` when given): its permissions and units read and its ability
   * built as `load()` does, never cached, every answer from the checks
   * `can()` and `redact()` make, and each permission (and each of its
   * conditions) checked alone the same way. `hidden`: the declared fields
   * the asker may not read on the record; an answer a condition on one of
   * them decides is withheld (null).
   */
  async explain(
    principal: Principal,
    subject: string,
    actions: string[],
    record?: Record<string, unknown>,
    hidden: string[] = [],
  ): Promise<Explanation> {
    const now = new Date();
    // One after the other: the caller may be in a transaction (one connection).
    const { held } = await this.loadPermissions(principal, now);
    const { context } = await this.loadContext(principal, now);
    const ability = abilityOf(
      this.catalog,
      principal,
      held.map((grant) => grant.permission),
      context,
    );
    const reaches = (permission: PermissionInput, action: string) => {
      if (!record) return true;
      if (!isAll(permission)) {
        const comparisons = this.catalog.comparisons(
          principal,
          permission,
          context,
        );
        if (!comparisons) return false;
        if (comparisons.some(({ field }) => hidden.includes(field)))
          return null;
      }
      return this.decide(
        abilityOf(this.catalog, principal, [permission], context),
        action,
        subject,
        record,
      );
    };
    return {
      held,
      context,
      actions: actions.map((action) => {
        const grants = held.flatMap(({ permission }, index) =>
          isAll(permission) ||
          (permission.subject === subject && permission.action === action)
            ? [
                {
                  index,
                  matches: reaches(permission, action),
                  conditions: permission.conditions.map((condition) => ({
                    key: condition.key,
                    matches: reaches(
                      { ...permission, conditions: [condition] },
                      action,
                    ),
                  })),
                },
              ]
            : [],
        );
        const withheld = grants.some((grant) => grant.matches === null);
        return {
          action,
          allowed: withheld
            ? null
            : this.decide(ability, action, subject, record),
          fields: withheld
            ? null
            : this.permittedFields(ability, action, subject, record),
          grants,
        };
      }),
    };
  }

  /** `can()`'s answer from an ability: a deleted record (soft delete) can only be restored. */
  private decide(
    ability: AppAbility,
    action: string,
    subject: string,
    record?: Record<string, unknown>,
  ) {
    if (
      record &&
      action !== 'restore' &&
      this.catalog.deletedAt(subject) &&
      record.deletedAt != null
    ) {
      return false;
    }
    return record
      ? ability.can(action, asSubject(subject, { ...record }))
      : ability.can(action, subject);
  }

  /** The declared fields `action` may touch on this record, or on some record without one. */
  private permittedFields(
    ability: AppAbility,
    action: string,
    subject: string,
    record?: Record<string, unknown>,
  ) {
    const declared = this.catalog.declaredFields(subject);
    if (!record) {
      return declared.filter((field) => ability.can(action, subject, field));
    }
    const allowed = new Set(
      permittedFieldsOf(ability, action, asSubject(subject, { ...record }), {
        fieldsFrom: (rule) => rule.fields ?? declared,
      }),
    );
    return declared.filter((field) => allowed.has(field));
  }

  private async load(principal: Principal): Promise<Loaded> {
    if (principal.kind === 'system' && !isSystemPrincipal(principal)) {
      // `kind: 'system'` read from data: nothing, and never the cached
      // ability of the real one (the cache is keyed by principalKey).
      return {
        version: this.generation('-'),
        permissions: [],
        context: NO_UNITS,
        ability: abilityOf(this.catalog, principal, [], NO_UNITS),
      };
    }
    // Per tenant: the same person holds other roles in another tenant, and
    // the system principal's conditions read the job's tenant's rows. A
    // break-glass request's ability is its grant's, never the person's own
    // in that tenant (an operator may also be a member there).
    const tenant = currentTenantScope()?.tenantId ?? '-';
    const key = `${tenant}:${principalKey(principal)}${principal.kind === 'user' && principal.breakGlass ? `:break-glass:${principal.breakGlass.grantId}` : ''}`;
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.loaded.version === this.generation(tenant) &&
      Date.now() < cached.until
    ) {
      return cached.loaded;
    }
    const version = this.generation(tenant);
    // Misses at the same moment share one load: redactAll() over a page
    // would otherwise query the grants once per row.
    const pendingKey = `${version}:${key}`;
    const pending = this.loading.get(pendingKey);
    if (pending) return pending;
    const loading = this.loadFresh(principal, tenant, key, version).finally(
      () => this.loading.delete(pendingKey),
    );
    this.loading.set(pendingKey, loading);
    return loading;
  }

  private async loadFresh(
    principal: Principal,
    tenant: string,
    key: string,
    version: string,
  ): Promise<Loaded> {
    const now = new Date();
    // One after the other: the caller may be in a transaction (one connection).
    const { held, nextExpiry } = await this.loadPermissions(principal, now);
    const { context, nextChange } = await this.loadContext(principal, now);
    const permissions = held.map((grant) => grant.permission);
    const loaded: Loaded = {
      version,
      permissions,
      context,
      ability: abilityOf(this.catalog, principal, permissions, context),
    };
    // Only what was built against the current version, never past the
    // next grant's end or membership change (nor a minute).
    if (version === this.generation(tenant)) {
      this.makeRoom();
      this.cache.set(key, {
        loaded,
        until: Math.min(
          Date.now() + AccessService.MAX_AGE_MS,
          nextExpiry ?? Infinity,
          nextChange ?? Infinity,
        ),
      });
    }
    return loaded;
  }

  /** What the principal holds now, by grant, and when the first of its grants ends. */
  private async loadPermissions(
    principal: Principal,
    now: Date,
  ): Promise<{ held: HeldPermission[]; nextExpiry?: number }> {
    const builtIn = (permissions: PermissionInput[]): HeldPermission[] =>
      permissions.map((permission) => ({
        permission,
        roleId: null,
        expiresAt: null,
      }));
    if (principal.kind === 'system') {
      // Made in code (load() turned away any other), for a declared job.
      return {
        held: isSystemPrincipal(principal)
          ? builtIn(this.catalog.systemJob(principal.id)?.permissions ?? [])
          : [],
      };
    }
    const scope = currentTenantScope();
    if (!scope?.tenantId) {
      // Roles are per tenant: without one, none.
      return { held: [] };
    }
    if (principal.kind === 'user' && principal.breakGlass) {
      // An operator reading a tenant through a break-glass grant: every
      // action of the catalog, unconditional, whatever their roles, so any
      // route an administrator reads opens; only in the grant's tenant, in a
      // read-only scope (GET, HEAD, OPTIONS; READ ONLY transactions).
      return {
        held:
          scope.readOnly && scope.tenantId === principal.breakGlass.tenantId
            ? builtIn(this.catalog.breakGlassPermissions())
            : [],
      };
    }
    const rows = await this.repository.grantedPermissions(
      principal.kind,
      principal.id,
      now,
    );
    const expiries = rows.flatMap((row) =>
      row.expiresAt ? [row.expiresAt.getTime()] : [],
    );
    const held: HeldPermission[] = rows.map(
      ({ subject, action, conditions, fields, roleId, expiresAt }) => ({
        permission: { subject, action, conditions, fields },
        roleId,
        expiresAt,
      }),
    );
    return {
      held:
        principal.kind === 'client'
          ? [...builtIn(this.catalog.clientPermissions), ...held]
          : held,
      nextExpiry: expiries.length ? Math.min(...expiries) : undefined,
    };
  }

  /** The principal's units (users in a tenant only), as the unit conditions read them. */
  private async loadContext(
    principal: Principal,
    now: Date,
  ): Promise<{ context: AccessContext; nextChange?: number }> {
    if (
      principal.kind !== 'user' ||
      principal.breakGlass ||
      !currentTenantScope()?.tenantId ||
      !this.units
    ) {
      return { context: NO_UNITS };
    }
    return this.units.context(principal.id, now);
  }
}
