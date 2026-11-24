import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import {
  currentTenantScope,
  requireTenantId,
} from '../../core/tenancy/tenant-scope.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { OperatorGuard } from '../../iam/auth/operator-only.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { OrganizationService } from '../../iam/organization/organization.service.js';
import { SettingsCache } from './settings.cache.js';
import { SettingsCatalog } from './settings.catalog.js';
import { SettingsPolicy } from './settings.policy.js';
import { SettingsRepository } from './settings.repository.js';
import { resolveSetting, type SettingSource } from './settings.resolution.js';
import {
  type FlagRule,
  parseRules,
  type RuleAttributes,
  rulesNeed,
} from './settings.rules.js';
import type {
  SetPlatformSettingDto,
  SetSettingDto,
} from './settings.schemas.js';
import { platformSettingValues, settingOverrides } from './settings.tables.js';
import type {
  PlatformSettingValue,
  SettingDeclaration,
  SettingScope,
} from './settings.types.js';
import type { SettingValueSchema } from './settings.value-schema.js';

/** A setting as a caller sees it: its value for them, what values it takes, and what they may change. */
export interface SettingView extends SettingValueSchema {
  key: string;
  label: string;
  description: string | null;
  flag: boolean;
  secret: boolean;
  scopes: readonly SettingScope[];
  public: boolean;
  /** Null for a secret: `source` says whether one is set. */
  value: unknown;
  source: SettingSource;
  default: unknown;
  /** May set and remove its value at every scope it takes (PUT/DELETE /settings/{key}). */
  canEdit: boolean;
  /** May set their own value (PUT/DELETE /settings/{key}/mine). */
  canSetMine: boolean;
  /** What the operators set for every tenant, if anything. */
  platform: PlatformSettingValue | null;
  /** May set and remove the platform value (PUT/DELETE /settings/{key}/platform): an operator. */
  canEditPlatform: boolean;
}

/** A write about to be stored: who, at which scope, which value. */
interface PendingWrite {
  actor: Principal;
  scope: SettingScope | 'platform';
  scopeId: string | undefined;
  value: unknown;
}
/** A refusal (409 `code`) or nothing (`guardWrite()`). */
type WriteGuard = (
  write: PendingWrite,
) => Promise<{ code: string; message: string } | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const invalid = (
  errors: { path: string; message: string }[],
  message = 'The setting is invalid.',
) => new BadRequestException({ code: 'validation_failed', message, errors });

/**
 * Settings and feature flags: the declarations are code (registered with
 * `SettingsModule.forFeature()`), the values administrators and users set
 * are rows of their tenant (row-level security), read through SettingsCache.
 * Outside any tenant (a user without one, a job of none) a setting is its
 * default, or what the operators set for every tenant (`setPlatform()`).
 * Precedence for a principal: README.md.
 */
@Injectable()
export class SettingsService {
  /** Deployment limits on values (`restrict()`), by key. */
  private readonly restrictions = new Map<
    string,
    ((value: unknown) => string | undefined)[]
  >();
  /** Checks on who may store which value (`guardWrite()`), by key. */
  private readonly writeGuards = new Map<string, WriteGuard[]>();

  constructor(
    private readonly repository: SettingsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly cache: SettingsCache,
    private readonly catalog: SettingsCatalog,
    private readonly audit: AuditService,
    private readonly policy: SettingsPolicy,
    private readonly tenancy: Tenancy,
    private readonly units: OrganizationService,
    private readonly operators: OperatorGuard,
    private readonly encryption: EncryptionService,
  ) {}

  declarations() {
    return this.catalog.declarations();
  }

  /** A declared setting, or a 404. */
  declaration(key: string) {
    return this.catalog.declaration(key);
  }

  /** Calls `listener` when the platform values change (here or on another instance). */
  onPlatformChange(listener: () => void) {
    this.cache.onPlatformChange(listener);
  }

  /**
   * Refuses values of `key` the deployment doesn't allow, when they are set
   * (`check` answers why, or undefined): a ceiling the environment puts on
   * what a tenant may choose. A refused value is a 400 `setting_not_allowed`.
   * What is already stored stays: whoever reads the setting applies the
   * ceiling again. Call it from the owner's constructor.
   */
  restrict<T>(
    declaration: SettingDeclaration<T>,
    check: (value: T) => string | undefined,
  ) {
    const checks = this.restrictions.get(declaration.key) ?? [];
    checks.push(check as (value: unknown) => string | undefined);
    this.restrictions.set(declaration.key, checks);
  }

  /**
   * Refuses a write of `key` by this caller when `check` answers a refusal
   * (a 409 with that stable `code`): for a value that would lock the writer
   * out. Unlike `restrict()`, it knows who writes and at which scope.
   */
  guardWrite<T>(declaration: SettingDeclaration<T>, check: WriteGuard) {
    const checks = this.writeGuards.get(declaration.key) ?? [];
    checks.push(check);
    this.writeGuards.set(declaration.key, checks);
  }

  private async assertWriter(
    actor: Principal,
    key: string,
    scope: SettingScope | 'platform',
    scopeId: string | undefined,
    value: unknown,
  ) {
    for (const check of this.writeGuards.get(key) ?? []) {
      const refusal = await check({ actor, scope, scopeId, value });
      if (refusal) throw new ConflictException(refusal);
    }
  }

  /** A 400 `setting_not_allowed` when a restriction refuses the value. */
  private assertAllowed(key: string, value: unknown) {
    for (const check of this.restrictions.get(key) ?? []) {
      const reason = check(value);
      if (reason) {
        throw new BadRequestException({
          code: 'setting_not_allowed',
          message: reason,
          errors: [{ path: 'value', message: reason }],
        });
      }
    }
  }

  /**
   * Whether any value that applies to the principal is `true`: the tenant's,
   * one of their units', their own (when the setting takes a user scope). For
   * policies whose `true` is the strict side: a narrower scope's `false`
   * doesn't exempt anyone from a wider scope's `true`, as the usual
   * precedence (`resolve()`) would. No rollout counts. The operators'
   * platform `true` counts as the widest scope; their `false`, even
   * enforced, exempts no one either.
   */
  async anyOn(
    declaration: SettingDeclaration<boolean>,
    principal: Principal,
  ): Promise<boolean> {
    if ((await this.platformValue(declaration.key))?.value === true) {
      return true;
    }
    const on = (
      (await this.cache.overrides()).get(declaration.key) ?? []
    ).filter((override) => override.value === true);
    if (on.some((override) => override.scope === 'tenant')) return true;
    const scopes = declaration.scopes ?? ['tenant'];
    if (
      scopes.includes('user') &&
      on.some(
        (override) =>
          override.scope === 'user' &&
          override.scopeId === principalKey(principal),
      )
    ) {
      return true;
    }
    const units = on.filter((override) => override.scope === 'unit');
    if (
      !scopes.includes('unit') ||
      principal.kind !== 'user' ||
      !units.length
    ) {
      return false;
    }
    const mine = new Set(await this.units.unitsOf(principal.id));
    return units.some((override) => mine.has(override.scopeId));
  }

  /** The value of a setting for a principal (none: for everyone). */
  async get<T>(
    declaration: SettingDeclaration<T>,
    principal: Principal | null = null,
  ): Promise<T> {
    return (await this.resolve(declaration, principal)).value;
  }

  /** Whether a flag is on for a principal (none: for everyone, rollouts aside). */
  enabled(
    declaration: SettingDeclaration<boolean>,
    principal: Principal | null = null,
  ) {
    return this.get(declaration, principal);
  }

  /** A setting's value for a principal, and where it comes from. */
  async resolve<T>(
    declaration: SettingDeclaration<T>,
    principal: Principal | null,
  ) {
    const overrides = (await this.cache.overrides()).get(declaration.key) ?? [];
    const units =
      principal?.kind === 'user' &&
      (declaration.scopes ?? []).includes('unit') &&
      overrides.some((override) => override.scope === 'unit')
        ? await this.units.unitsOf(principal.id)
        : [];
    const platform = await this.platformValue(declaration.key);
    return resolveSetting(
      declaration,
      overrides,
      principal,
      units,
      currentTenantScope()?.tenantId ?? null,
      platform,
      declaration.flag
        ? await this.ruleAttributes(principal, [
            overrides.find((o) => o.scope === 'tenant')?.rules ?? [],
            platform?.rules ?? [],
          ])
        : null,
    );
  }

  /**
   * What the targeting rules are evaluated against: the principal's kind,
   * verified email, language, the roles it holds and its tenant. Each part
   * is read only when a rule names it. None for the system principal (a
   * job) and a guest: no rule matches them (fail closed).
   */
  private async ruleAttributes(
    principal: Principal | null,
    ruleSets: readonly (readonly FlagRule[])[],
  ): Promise<RuleAttributes | null> {
    const rules = ruleSets.flat();
    if (!rules.length || !principal || principal.kind === 'system') {
      return null;
    }
    const attributes: RuleAttributes = {
      kind: principal.kind,
      email:
        principal.kind === 'user' && principal.emailVerified
          ? principal.email
          : null,
      locale: principal.kind === 'user' ? principal.locale : null,
      tenant: null,
    };
    const tenantId = currentTenantScope()?.tenantId;
    if (!tenantId) return attributes;
    if (rulesNeed(rules, ['tenantSlug', 'tenantOperator'])) {
      const tenant = await this.tenancy.find(tenantId);
      attributes.tenant = tenant
        ? {
            slug: tenant.slug,
            operator: await this.operators.actsAsOperator(principal),
          }
        : null;
    }
    if (rulesNeed(rules, ['role'])) {
      attributes.roleIds = new Set(
        await this.repository.liveRoleIdsOf(principal.kind, principal.id),
      );
    }
    return attributes;
  }

  /** A 400 when a rule names a role that is not one of the tenant's. */
  private async assertRolesExist(rules: readonly FlagRule[]) {
    const wanted = new Set(
      rules.flatMap((rule) =>
        rule.conditions
          .filter((condition) => condition.key === 'role')
          .flatMap((condition) => condition.params.roleIds as string[]),
      ),
    );
    if (!wanted.size) return;
    const found = new Set(await this.repository.roleIds());
    const missing = [...wanted].filter((id) => !found.has(id));
    if (missing.length) {
      throw invalid([
        { path: 'rules', message: `No such role: ${missing.join(', ')}.` },
      ]);
    }
  }

  /** Every setting the caller may see, with their value for them. */
  async effective(principal: Principal) {
    const canRead = await this.canRead(principal);
    const canEdit = await this.canEdit(principal);
    const canEditPlatform = await this.canEditPlatform(principal, canEdit);
    const views: SettingView[] = [];
    for (const declaration of this.catalog.declarations()) {
      if (declaration.public === false && !canRead) continue;
      views.push(
        await this.view(declaration, principal, canEdit, canEditPlatform),
      );
    }
    return views;
  }

  /** Whether the principal may see non-public settings and every stored value (Setting.read). */
  canRead(principal: Principal) {
    return this.policy.read(principal);
  }

  /**
   * Whether the principal may set and remove a setting's shared values
   * (PUT and DELETE /settings/{key}): the very policy those routes check,
   * the same at every scope, so one answer holds for all of them.
   */
  canEdit(principal: Principal) {
    return this.policy.update(principal);
  }

  /** Whether the principal may set the platform values: Setting.update, acting in the operators' tenant. */
  async canEditPlatform(principal: Principal, canEdit?: boolean) {
    return (
      (canEdit ?? (await this.canEdit(principal))) &&
      (await this.operators.actsAsOperator(principal))
    );
  }

  /** One setting with the principal's value: a non-public one is a 404 to who may not read it. */
  async viewOf(principal: Principal, key: string) {
    const declaration = this.declaration(key);
    if (declaration.public === false && !(await this.canRead(principal))) {
      throw new NotFoundException(`No setting "${key}".`);
    }
    return this.view(declaration, principal);
  }

  async view(
    declaration: SettingDeclaration<any>,
    principal: Principal,
    canEdit?: boolean,
    canEditPlatform?: boolean,
  ): Promise<SettingView> {
    const { value, source } = await this.resolve(declaration, principal);
    const scopes = declaration.scopes ?? ['tenant'];
    canEdit ??= await this.canEdit(principal);
    const platform = await this.platformValue(declaration.key);
    return {
      ...this.catalog.valueSchema(declaration.key),
      key: declaration.key,
      label: declaration.label,
      description: declaration.description ?? null,
      flag: declaration.flag === true,
      secret: declaration.secret === true,
      scopes,
      public: declaration.public !== false,
      value: declaration.secret ? null : value,
      source,
      default: declaration.default,
      canEdit,
      // PUT /settings/{key}/mine takes anyone, for a setting set per user.
      canSetMine: scopes.includes('user'),
      platform:
        platform && declaration.secret
          ? { ...platform, value: null }
          : (platform ?? null),
      canEditPlatform:
        canEditPlatform ?? (await this.canEditPlatform(principal, canEdit)),
    };
  }

  /** The stored overrides of a setting, every scope (a secret's value left out). */
  async overrides(key: string) {
    const declaration = this.declaration(key);
    return ((await this.cache.overrides()).get(key) ?? []).map((row) =>
      this.shownRow(declaration, row),
    );
  }

  /**
   * Sets a setting for a scope (replacing what that scope had), checked
   * against the declaration: the scope must be one it allows, the value
   * must pass its schema, a rollout is for flags at the tenant scope.
   * Audited; applies everywhere on the next request.
   */
  async set(actor: Principal, key: string, dto: SetSettingDto, ip?: string) {
    const declaration = this.declaration(key);
    const scope = dto.scope;
    const scopeId = await this.scopeId(declaration, scope, dto.scopeId);
    const issues: { path: string; message: string }[] = [];
    const hasRules = (dto.rules?.length ?? 0) > 0;
    if (dto.value === undefined && dto.rollout == null && !hasRules) {
      issues.push({ path: 'value', message: 'A value is required.' });
    }
    if (dto.rollout != null && !(declaration.flag && scope === 'tenant')) {
      issues.push({
        path: 'rollout',
        message: 'Only a flag rolls out, at the tenant scope.',
      });
    }
    // Left out: the scope's rules stay (a client that only knows values keeps them); [] clears.
    let rules: FlagRule[] | undefined;
    if (dto.rules !== undefined) {
      if (dto.rules.length && !(declaration.flag && scope === 'tenant')) {
        issues.push({
          path: 'rules',
          message: 'Only a flag has rules, at the tenant scope.',
        });
      } else {
        const parsed = parseRules(dto.rules, 'tenant');
        if (parsed.ok) rules = parsed.rules;
        else issues.push(...parsed.issues);
      }
    }
    const value = this.parseValue(declaration, dto.value, issues);
    if (issues.length) throw invalid(issues);
    if (dto.value !== undefined) {
      this.assertAllowed(key, value);
      await this.assertWriter(actor, key, scope, scopeId, value);
    }
    await this.assertRolesExist(rules ?? []);
    return this.write(
      actor,
      declaration,
      scope,
      scopeId,
      value,
      dto.rollout ?? null,
      ip,
      rules,
    );
  }

  /** The value as the schema reads it (null when none was sent); problems go to `issues`. */
  private parseValue(
    declaration: SettingDeclaration<any>,
    sent: unknown,
    issues: { path: string; message: string }[],
  ): unknown {
    if (sent === undefined) return null;
    const parsed = declaration.schema.safeParse(sent);
    if (parsed.success) return parsed.data;
    issues.push(
      ...parsed.error.issues.map((issue) => ({
        path: ['value', ...issue.path].join('.'),
        message: issue.message,
      })),
    );
    return null;
  }

  /** A stored row as the API shows it: never the encrypted column, a secret's value never. */
  private shownRow(
    declaration: SettingDeclaration<any>,
    row: {
      key: string;
      value: unknown;
      rollout: number | null;
      rules: FlagRule[];
      updatedBy: string;
      updatedAt: Date;
    } & Partial<{ scope: SettingScope; scopeId: string; enforced: boolean }>,
  ) {
    return {
      key: row.key,
      ...(row.scope !== undefined && {
        scope: row.scope,
        scopeId: row.scopeId,
      }),
      value: declaration.secret ? null : row.value,
      ...(row.enforced !== undefined && { enforced: row.enforced }),
      rollout: row.rollout,
      rules: row.rules,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }

  /** What a stored value looks like in an audit entry: a secret never. */
  private shown(declaration: SettingDeclaration<any>, value: unknown) {
    return declaration.secret && value !== null ? '[secret]' : value;
  }

  /** The columns holding a value: a secret in its encrypted column, anything else as JSON. */
  private stored(
    declaration: SettingDeclaration<any>,
    column:
      typeof settingOverrides.secret | typeof platformSettingValues.secret,
    value: unknown,
  ) {
    return declaration.secret && value !== null
      ? {
          value: null,
          secret: this.encryption.encrypt(column, value as string),
        }
      : { value, secret: null };
  }

  /** Removes a scope's override: back to the next scope's value, or the default. */
  async unset(
    actor: Principal,
    key: string,
    scope: SettingScope,
    scopeId: string | undefined,
    ip?: string,
  ) {
    const declaration = this.declaration(key);
    const id = await this.scopeId(declaration, scope, scopeId);
    // A removal is a write too (no value): a lock on the setting holds for it.
    await this.assertWriter(actor, key, scope, id, undefined);
    await this.remove(actor, declaration, scope, id, ip);
  }

  /**
   * Sets what holds for every tenant (an operator's, the route checks
   * who): below each tenant's own values, or above them all when
   * `enforced` (a kill switch). Audited in the operator's tenant; applies
   * everywhere on the next request.
   */
  async setPlatform(
    actor: Principal,
    key: string,
    dto: SetPlatformSettingDto,
    ip?: string,
  ) {
    const declaration = this.declaration(key);
    const rollout = dto.rollout ?? null;
    const enforced = dto.enforced ?? false;
    const issues: { path: string; message: string }[] = [];
    if (
      dto.value === undefined &&
      rollout === null &&
      !(dto.rules?.length ?? 0)
    ) {
      issues.push({ path: 'value', message: 'A value is required.' });
    }
    let rules: FlagRule[] | undefined;
    if (dto.rules?.length === 0) {
      rules = [];
    } else if (dto.rules) {
      if (!declaration.flag) {
        issues.push({ path: 'rules', message: 'Only a flag has rules.' });
      } else {
        const parsed = parseRules(dto.rules, 'platform');
        if (parsed.ok) rules = parsed.rules;
        else issues.push(...parsed.issues);
      }
    }
    if (rollout !== null && !declaration.flag) {
      issues.push({ path: 'rollout', message: 'Only a flag rolls out.' });
    }
    if (enforced && dto.value === undefined) {
      issues.push({
        path: 'enforced',
        message: 'Only a value is enforced, not a rollout.',
      });
    }
    const value = this.parseValue(declaration, dto.value, issues);
    if (issues.length) throw invalid(issues);
    if (dto.value !== undefined) {
      this.assertAllowed(key, value);
      await this.assertWriter(actor, key, 'platform', undefined, value);
    }
    const row = await this.txHost.withTransaction(async () => {
      const before = await this.repository.findPlatformValue(key);
      const kept = rules ?? before?.rules ?? [];
      const columns = {
        ...this.stored(declaration, platformSettingValues.secret, value),
        enforced,
        rollout,
        rules: kept,
        updatedBy: principalKey(actor),
      };
      const after = await this.repository.savePlatformValue(key, columns);
      await this.audit.record(actor, {
        action: 'setting.updated',
        targetType: 'setting',
        targetId: key,
        details: {
          scope: 'platform',
          scopeId: '',
          from: before
            ? {
                value: this.shown(declaration, before.value ?? before.secret),
                enforced: before.enforced,
                rollout: before.rollout,
                rules: before.rules,
              }
            : null,
          to: {
            value: this.shown(declaration, value),
            enforced,
            rollout,
            rules: kept,
          },
        },
        ip,
      });
      return after;
    });
    this.cache.invalidate();
    return this.shownRow(declaration, row);
  }

  /** Removes the platform value: each tenant's own, or the default, holds again. */
  async unsetPlatform(actor: Principal, key: string, ip?: string) {
    const declaration = this.declaration(key);
    const removed = await this.txHost.withTransaction(async () => {
      const before = await this.repository.deletePlatformValue(key);
      if (before) {
        await this.audit.record(actor, {
          action: 'setting.reset',
          targetType: 'setting',
          targetId: key,
          details: {
            scope: 'platform',
            scopeId: '',
            from: {
              value: this.shown(declaration, before.value ?? before.secret),
              enforced: before.enforced,
              rollout: before.rollout,
              rules: before.rules,
            },
          },
          ip,
        });
      }
      return before;
    });
    if (removed) this.cache.invalidate();
  }

  /** A principal's own value of a setting that takes one (`user` among its scopes). */
  async setMine(
    principal: Principal,
    key: string,
    value: unknown,
    ip?: string,
  ) {
    const declaration = this.declaration(key);
    if (!(declaration.scopes ?? []).includes('user')) {
      throw invalid(
        [{ path: 'key', message: 'Not set per user.' }],
        'This setting is not set per user.',
      );
    }
    const issues: { path: string; message: string }[] = [];
    const parsed = this.parseValue(declaration, value ?? null, issues);
    if (issues.length) throw invalid(issues, 'The value is invalid.');
    this.assertAllowed(key, parsed);
    await this.write(
      principal,
      declaration,
      'user',
      principalKey(principal),
      parsed,
      null,
      ip,
    );
    return this.view(declaration, principal);
  }

  async unsetMine(principal: Principal, key: string, ip?: string) {
    const declaration = this.declaration(key);
    await this.remove(
      principal,
      declaration,
      'user',
      principalKey(principal),
      ip,
    );
    return this.view(declaration, principal);
  }

  /**
   * The scope's id as stored: '' for the tenant; one of its units; one of
   * its members or API clients (a user is global: a member of the tenant,
   * by its memberships; a unit or a client of another tenant is no row,
   * row-level security).
   */
  private async scopeId(
    declaration: SettingDeclaration<any>,
    scope: SettingScope,
    scopeId: string | undefined,
  ) {
    if (!(declaration.scopes ?? ['tenant']).includes(scope)) {
      throw invalid([
        {
          path: 'scope',
          message: `"${declaration.key}" is not set per ${scope}.`,
        },
      ]);
    }
    if (scope === 'tenant') return '';
    if (!scopeId) {
      throw invalid([
        { path: 'scopeId', message: `Required for the ${scope} scope.` },
      ]);
    }
    if (scope === 'unit') {
      const unit = await this.repository.findUnitId(scopeId);
      if (!unit) {
        throw new NotFoundException(
          `Organizational unit ${scopeId} not found.`,
        );
      }
      return unit;
    }
    const [kind, id] = scopeId.split(':') as [string, string | undefined];
    const found =
      kind === 'user' && id && UUID.test(id)
        ? await this.repository.isMember(id, requireTenantId('A setting'))
        : kind === 'client' && id && UUID.test(id)
          ? await this.repository.clientExists(id)
          : false;
    if (!found) {
      throw new NotFoundException(`Principal ${scopeId} not found.`);
    }
    return scopeId;
  }

  private async write(
    actor: Principal,
    declaration: SettingDeclaration<any>,
    scope: SettingScope,
    scopeId: string,
    value: unknown,
    rollout: number | null,
    ip?: string,
    rules?: FlagRule[],
  ) {
    const key = declaration.key;
    const row = await this.txHost.withTransaction(async () => {
      const before = await this.repository.findOverride({
        key,
        scope,
        scopeId,
      });
      const kept = rules ?? before?.rules ?? [];
      const columns = {
        ...this.stored(declaration, settingOverrides.secret, value),
        rollout,
        rules: kept,
        updatedBy: principalKey(actor),
      };
      const after = await this.repository.saveOverride(
        { key, scope, scopeId },
        columns,
      );
      await this.audit.record(actor, {
        action: 'setting.updated',
        targetType: 'setting',
        targetId: key,
        details: {
          scope,
          scopeId,
          from: before
            ? {
                value: this.shown(declaration, before.value ?? before.secret),
                rollout: before.rollout,
                rules: before.rules,
              }
            : null,
          to: { value: this.shown(declaration, value), rollout, rules: kept },
        },
        ip,
      });
      return after;
    });
    this.cache.invalidate(row.tenantId);
    return this.shownRow(declaration, row);
  }

  private async remove(
    actor: Principal,
    declaration: SettingDeclaration<any>,
    scope: SettingScope,
    scopeId: string,
    ip?: string,
  ) {
    const key = declaration.key;
    const removed = await this.txHost.withTransaction(async () => {
      const before = await this.repository.deleteOverride({
        key,
        scope,
        scopeId,
      });
      if (before) {
        await this.audit.record(actor, {
          action: 'setting.reset',
          targetType: 'setting',
          targetId: key,
          details: {
            scope,
            scopeId,
            from: {
              value: this.shown(declaration, before.value ?? before.secret),
              rollout: before.rollout,
              rules: before.rules,
            },
          },
          ip,
        });
      }
      return before;
    });
    if (removed) this.cache.invalidate(removed.tenantId);
  }

  /** The operators' value of a setting for every tenant, if any. */
  private async platformValue(
    key: string,
  ): Promise<PlatformSettingValue | undefined> {
    const row = (await this.cache.platformValues()).get(key);
    return row
      ? {
          value: row.value,
          enforced: row.enforced,
          rollout: row.rollout,
          rules: row.rules,
        }
      : undefined;
  }
}
