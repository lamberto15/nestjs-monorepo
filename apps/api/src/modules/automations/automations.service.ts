import { isDeepStrictEqual } from 'node:util';
import { Transactional } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { t } from '@nestjs/i18n';
import type { ListQuery } from '../../core/http/list-query.js';
import { toPage } from '../../core/http/pagination.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { type Expression, ExpressionError } from '../expressions/expression.js';
import { type RecordRow, recordView } from '../records/record.js';
import {
  Records,
  type RecordRegistration,
} from '../records/records.service.js';
import {
  type ActionProblem,
  AutomationActions,
  type PlannedAction,
} from './automation-actions.js';
import { titleOf } from './automations.actions.js';
import {
  compileCondition,
  conditionVariables,
} from './automations.conditions.js';
import { AutomationsRepository } from './automations.repository.js';
import type {
  AutomationSimulation,
  CreateAutomationRuleDto,
  SimulateAutomationRuleDto,
  UpdateAutomationRuleDto,
} from './automations.schemas.js';
import {
  type AutomationRule,
  type AutomationRun,
  type RunAction,
  type StoredAction,
} from './automations.tables.js';

/** At most this many active rules per tenant: a write starts at most this many runs. */
export const MAX_ACTIVE_RULES = 20;
/** Runs of one rule in an hour, at most: past it the rule is disabled (`run_limit`). */
export const MAX_RUNS_PER_HOUR = 100;
/** Failed runs in a row before the rule is disabled (`failing`). */
export const MAX_FAILURES = 5;
/** The capability AutomationsModule.forRecord() gives a record (its extension's). */
export const AUTOMATIONS_CAPABILITY = 'automations';

/** The parts of a rule that decide what it does. */
export type Definition = Pick<
  AutomationRule,
  'subject' | 'trigger' | 'field' | 'condition' | 'actions'
>;

/** One action of a rule, checked: what the run log keeps, and how it is done. */
export interface Planned {
  result: RunAction;
  apply?: () => Promise<void>;
}

/** A run that trying again would not change (a permission, a condition that can't be computed). */
export class AutomationRefused extends Error {}

const view = (rule: AutomationRule) => ({
  id: rule.id,
  name: rule.name,
  subject: rule.subject,
  trigger: rule.trigger,
  field: rule.field,
  condition: rule.condition,
  actions: rule.actions,
  status: rule.status,
  version: rule.version,
  owner: rule.owner,
  activatedAt: rule.activatedAt?.toISOString() ?? null,
  disabledReason: rule.disabledReason,
  failures: rule.failures,
  lastRunAt: rule.lastRunAt?.toISOString() ?? null,
  lastStatus: rule.lastStatus ?? null,
  createdAt: rule.createdAt.toISOString(),
  updatedAt: rule.updatedAt.toISOString(),
});

const runView = (run: AutomationRun) => ({
  id: run.id,
  ruleVersion: run.ruleVersion,
  recordId: run.recordId,
  status: run.status,
  actions: run.actions,
  error: run.error,
  createdAt: run.createdAt.toISOString(),
});

const invalid = (errors: ActionProblem[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: t('automations.invalid'),
    errors,
  });

/**
 * Tenant automation rules (README.md): their routes' use cases, and the
 * evaluator a run and a simulation share (`check()`, `match()`,
 * `plan()`): a simulation is a run without `apply`. A rule runs as the
 * user who activated it, with their permissions as they are at each run
 * (AutomationRunner).
 */
@Injectable()
export class AutomationsService {
  constructor(
    private readonly repository: AutomationsRepository,
    private readonly records: Records,
    private readonly actions: AutomationActions,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly users: UsersRepository,
    private readonly tenancy: Tenancy,
  ) {}

  /** The record of a subject that takes rules (its feature imports AutomationsModule.forRecord()). */
  target(subject: string): RecordRegistration | undefined {
    const record = this.records.find(subject);
    return record?.extensions.some(
      (e) => e.capability === AUTOMATIONS_CAPABILITY,
    )
      ? record
      : undefined;
  }

  subjects() {
    return this.records
      .all()
      .filter((record) => this.target(record.declaration.subject))
      .sort((a, b) =>
        a.declaration.subject.localeCompare(b.declaration.subject),
      )
      .map((record) => ({
        subject: record.declaration.subject,
        path: record.declaration.path,
        fields: Object.keys(record.declaration.fields),
        variables: Object.entries(conditionVariables(record.declaration)).map(
          ([name, type]) => ({ name, type }),
        ),
        actions: this.actions.of(record).map(([type, handler]) => ({
          type,
          ...handler.describe?.(record),
        })),
      }));
  }

  async page(query: ListQuery) {
    const [rows, total] = await this.repository.page(query);
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map(view) };
  }

  private async find(id: string) {
    const rule = await this.repository.findById(id);
    if (!rule) {
      throw new NotFoundException(t('automations.notFound', { args: { id } }));
    }
    return rule;
  }

  /** The rule as it is now, or undefined (the runner's read). */
  async current(id: string) {
    return this.repository.findById(id);
  }

  async get(id: string) {
    return view(await this.find(id));
  }

  async runs(id: string, query: ListQuery) {
    await this.find(id);
    const rows = await this.repository.runs(id, query);
    const page = toPage(rows, query, undefined);
    return { ...page, items: page.items.map(runView) };
  }

  /** A draft: checked as its author would run it, run only once activated. */
  @Transactional()
  async create(user: UserPrincipal, dto: CreateAutomationRuleDto, ip?: string) {
    const { actions } = await this.check(user, dto);
    const row = await this.repository.insert({
      name: dto.name,
      subject: dto.subject,
      trigger: dto.trigger,
      field: dto.field,
      condition: dto.condition,
      actions,
    });
    await this.audit.record(user, {
      action: 'automation-rule.created',
      targetType: 'automationRule',
      targetId: row.id,
      details: { name: dto.name, subject: dto.subject },
      ip,
    });
    return view(row);
  }

  /**
   * Only what is sent changes. A change of the trigger, the condition or
   * the actions is a new version, and an active rule becomes a draft
   * again: it takes effect once activated (and so simulated) again.
   */
  @Transactional()
  async update(
    user: UserPrincipal,
    id: string,
    dto: UpdateAutomationRuleDto,
    ip?: string,
  ) {
    const current = await this.find(id);
    let definition: Definition = {
      subject: current.subject,
      trigger: dto.trigger ?? current.trigger,
      field: dto.field === undefined ? current.field : dto.field,
      condition:
        dto.condition === undefined ? current.condition : dto.condition,
      actions: dto.actions ?? current.actions,
    };
    const changed = (
      ['trigger', 'field', 'condition', 'actions'] as const
    ).some((key) => !isDeepStrictEqual(definition[key], current[key]));
    if (changed) {
      definition = {
        ...definition,
        actions: (await this.check(user, definition)).actions,
      };
    }
    const row = await this.repository.update(id, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(changed && {
        ...definition,
        version: current.version + 1,
        ...(current.status === 'active' && { status: 'draft' as const }),
      }),
    });
    await this.audit.record(user, {
      action: 'automation-rule.updated',
      targetType: 'automationRule',
      targetId: id,
      details: {
        version: row!.version,
        changed: Object.keys(dto),
        from: current.status,
        to: row!.status,
      },
      ip,
    });
    return view(row!);
  }

  @Transactional()
  async remove(user: UserPrincipal, id: string, ip?: string) {
    const rule = await this.find(id);
    await this.repository.delete(id);
    await this.audit.record(user, {
      action: 'automation-rule.deleted',
      targetType: 'automationRule',
      targetId: id,
      details: { name: rule.name, version: rule.version },
      ip,
    });
  }

  /**
   * The rule runs from now on, as `user` (its owner): checked again as
   * them. At most MAX_ACTIVE_RULES active rules in the tenant.
   */
  @Transactional()
  async activate(user: UserPrincipal, id: string, ip?: string) {
    const current = await this.find(id);
    if (current.status === 'active') {
      throw new ConflictException({
        code: 'automation_active',
        message: t('automations.active'),
      });
    }
    await this.check(user, current);
    if ((await this.repository.countActive()) >= MAX_ACTIVE_RULES) {
      throw invalid([
        {
          path: 'status',
          message: t('automations.tooManyActive', {
            args: { max: MAX_ACTIVE_RULES },
          }),
        },
      ]);
    }
    const updated = await this.repository.update(id, {
      status: 'active',
      owner: principalKey(user),
      activatedAt: new Date(),
      disabledReason: null,
      failures: 0,
    });
    await this.audit.record(user, {
      action: 'automation-rule.activated',
      targetType: 'automationRule',
      targetId: id,
      details: { version: updated.version },
      ip,
    });
    return view(updated!);
  }

  /** Stops the rule (`manual`): runs already queued find it disabled and do nothing. */
  @Transactional()
  async disable(user: UserPrincipal, id: string, ip?: string) {
    const current = await this.find(id);
    if (current.status === 'disabled') return view(current);
    return view(await this.setDisabled(current, 'manual', user, ip));
  }

  /** Disables a rule, audited as `by` (the user, or `system:automations`), in the current transaction. */
  async setDisabled(
    rule: AutomationRule,
    reason: string,
    by: Principal,
    ip?: string,
  ) {
    const updated = await this.repository.update(rule.id, {
      status: 'disabled',
      disabledReason: reason,
    });
    await this.audit.record(by, {
      action: 'automation-rule.disabled',
      targetType: 'automationRule',
      targetId: rule.id,
      details: { reason, version: rule.version },
      ip,
    });
    return updated;
  }

  /**
   * What the rule would do now, without doing any of it: the most recently
   * changed records the caller may read (or the ones named), at most
   * `limit`, those the condition holds for, and each action checked as the
   * caller (who would own the rule once they activate it).
   */
  async simulate(
    user: UserPrincipal,
    dto: SimulateAutomationRuleDto,
  ): Promise<AutomationSimulation> {
    const { target, expression, actions } = await this.check(user, dto);
    const rows = await this.readable(target, user, {
      ids: dto.recordIds,
      limit: dto.limit,
    });
    const matches = [];
    for (const row of rows) {
      if (!this.holds(target, expression, row, { lenient: true })) continue;
      const planned = await this.plan(
        target,
        user,
        { id: null, name: '', actions },
        row,
      );
      const shown = await this.access.redact(
        user,
        'read',
        target.declaration.subject,
        recordView(target.declaration, row) as Record<string, unknown>,
      );
      matches.push({
        recordId: row.id,
        title: titleOf(target, shown),
        actions: planned.map((p) => p.result),
      });
    }
    return {
      subject: target.declaration.subject,
      limit: dto.limit,
      matched: matches.length,
      truncated: !dto.recordIds && rows.length >= dto.limit,
      triggerSimulated: !(dto.trigger === 'updated' && dto.field),
      matches,
    };
  }

  /**
   * The definition checked as `principal` would run it: a subject that
   * takes rules, a watched field it has, a condition that compiles to
   * yes/no and reads no field hidden from them (403 `field_forbidden`),
   * actions it takes with valid parameters. Returns the record, the
   * compiled condition and the actions as stored (parameters parsed).
   */
  async check(principal: Principal, definition: Definition) {
    const target = this.target(definition.subject);
    if (!target) {
      throw invalid([
        {
          path: 'subject',
          message: t('automations.noSubject', {
            args: { subject: definition.subject },
          }),
        },
      ]);
    }
    const { subject, fields } = target.declaration;
    if (definition.field) {
      if (definition.trigger !== 'updated') {
        throw invalid([
          { path: 'field', message: t('automations.fieldOnUpdated') },
        ]);
      }
      if (!Object.hasOwn(fields, definition.field)) {
        throw invalid([
          {
            path: 'field',
            message: t('automations.noField', {
              args: { subject, field: definition.field },
            }),
          },
        ]);
      }
    }
    let expression: Expression | null = null;
    if (definition.condition) {
      try {
        expression = compileCondition(target.declaration, definition.condition);
      } catch (error) {
        if (error instanceof ExpressionError || error instanceof TypeError) {
          throw invalid([{ path: 'condition', message: error.message }]);
        }
        throw error;
      }
      await this.assertReadable(principal, subject, expression);
    }
    const errors: ActionProblem[] = [];
    const actions: StoredAction[] = [];
    for (const [index, { type, ...raw }] of definition.actions.entries()) {
      const path = `actions.${index}`;
      const handler = this.actions.find(type);
      if (!handler || !(handler.supports?.(target) ?? true)) {
        errors.push({
          path: `${path}.type`,
          message: t('automations.noAction', { args: { subject, type } }),
        });
        continue;
      }
      const parsed = handler.params.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          errors.push({
            path: [path, ...issue.path].join('.'),
            message: issue.message,
          });
        }
        continue;
      }
      for (const problem of (await handler.check?.(target, parsed.data)) ??
        []) {
        errors.push({
          path: `${path}.${problem.path}`,
          message: problem.message,
        });
      }
      actions.push({ ...(parsed.data as Record<string, unknown>), type });
    }
    if (errors.length) throw invalid(errors);
    return { target, expression, actions };
  }

  /**
   * A condition reading a field the principal may not read (on any record,
   * or only on some) would tell its value where a read hides it: 403.
   */
  private async assertReadable(
    principal: Principal,
    subject: string,
    expression: Expression,
  ) {
    const [denied, conditional] = await Promise.all([
      this.access.deniedFields(principal, 'read', subject),
      this.access.conditionalFields(principal, 'read', subject),
    ]);
    const forbidden = expression.reads.filter(
      (name) => denied.includes(name) || conditional.includes(name),
    );
    if (forbidden.length) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: t('automations.conditionForbidden', {
          args: { fields: forbidden.join(', ') },
        }),
        fields: forbidden,
      });
    }
  }

  /** The records `principal` may read, the most recently changed first, at most `limit` (with `ids`: only those). */
  async readable(
    target: RecordRegistration,
    principal: Principal,
    { ids, limit }: { ids?: readonly string[]; limit: number },
  ): Promise<RecordRow[]> {
    return this.repository.records(
      target.feature.table,
      await this.access.sqlFilter(
        principal,
        target.declaration.subject,
        'read',
      ),
      { ids, limit },
    );
  }

  /**
   * Whether the condition holds for the record, as the API shows it. One
   * that can't be computed (a division by zero) refuses the run; in a
   * simulation (`lenient`) the record just doesn't match.
   */
  holds(
    target: RecordRegistration,
    expression: Expression | null,
    row: RecordRow,
    { lenient = false }: { lenient?: boolean } = {},
  ) {
    if (!expression) return true;
    try {
      return expression.evaluate(recordView(target.declaration, row)) === true;
    } catch (error) {
      if (error instanceof ExpressionError) {
        if (lenient) return false;
        throw new AutomationRefused(`condition: ${error.code}`);
      }
      throw error;
    }
  }

  /** Each action checked as `principal` on the record: a run applies them, a simulation shows them. */
  async plan(
    target: RecordRegistration,
    principal: UserPrincipal,
    rule: { id: string | null; name: string; actions: readonly StoredAction[] },
    row: RecordRow,
  ): Promise<Planned[]> {
    const planned: Planned[] = [];
    for (const { type, ...params } of rule.actions) {
      const handler = this.actions.find(type);
      const found: PlannedAction = handler
        ? await handler.plan({
            record: target,
            principal,
            row,
            params,
            rule: { id: rule.id, name: rule.name },
          })
        : { allowed: false, reason: 'unknown_action', detail: type };
      planned.push({
        result: {
          type,
          allowed: found.allowed,
          reason: found.allowed ? null : (found.reason ?? 'forbidden'),
          detail: found.detail,
        },
        apply: found.apply,
      });
    }
    return planned;
  }

  /** The rule's owner as they are now, in the tenant; null when no longer an active member. */
  async owner(rule: AutomationRule): Promise<UserPrincipal | null> {
    const [kind, id] = (rule.owner ?? '').split(':');
    if (kind !== 'user' || !id) return null;
    return this.users.inTenant(id, this.tenancy.tenantId());
  }

  /** Runs of the rule in the last hour. */
  async recentRuns(ruleId: string) {
    return this.repository.countRunsSince(
      ruleId,
      new Date(Date.now() - 3_600_000),
    );
  }

  /** Keeps the run, and the rule's last run, in the current transaction; returns its failures in a row. */
  async recordRun(
    rule: AutomationRule,
    recordId: string,
    planned: readonly Planned[],
    error: string | null,
  ) {
    const status = error ? 'failed' : 'succeeded';
    await this.repository.insertRun({
      ruleId: rule.id,
      ruleVersion: rule.version,
      recordId,
      status,
      actions: planned.map((p) => p.result),
      error,
    });
    const failures = error ? rule.failures + 1 : 0;
    await this.repository.update(rule.id, {
      lastRunAt: new Date(),
      lastStatus: status,
      failures,
    });
    return failures;
  }
}
