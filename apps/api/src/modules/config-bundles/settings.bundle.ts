import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RolesService } from '../../iam/access/roles.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { parseRules } from '../settings/settings.rules.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  type BundleSectionHandler,
  BundleSection,
  type SectionPreview,
} from './config-bundles.sections.js';
import { canonicalJson } from './config-bundles.service.js';
import { rolesContentsSchema } from './roles.bundle.js';

type Rule = Record<string, unknown>;

export const settingsContentsSchema = z
  .array(
    z.object({
      key: z.string().min(1).max(200),
      /** Null: only `rollout` (or the rules) apply (a flag). */
      value: z.unknown(),
      rollout: z.number().int().min(0).max(100).nullable(),
      /** A `role` condition names roles (`{ roleNames }`), never this environment's ids. */
      rules: z.array(z.record(z.string(), z.unknown())).max(50),
    }),
  )
  .max(1000);
type Settings = z.infer<typeof settingsContentsSchema>;

/**
 * The tenant-scope values of the settings and flags (a flag's rollout and
 * rules too). Values of units and people, secrets and platform values stay
 * out. A flag rule's role condition carries role names, mapped to the
 * target's role ids on apply; an id of any other record (a unit in a
 * condition) is applied as is. Comes after the roles.
 */
@BundleSection('settings', { order: 10 })
@Injectable()
export class SettingsBundle implements BundleSectionHandler<Settings> {
  readonly schema = settingsContentsSchema;

  constructor(
    private readonly settings: SettingsService,
    private readonly roles: RolesService,
  ) {}

  async export(): Promise<Settings> {
    const names = new Map(
      (await this.roles.list()).map((role) => [role.id, role.name]),
    );
    const out: Settings = [];
    for (const declaration of this.settings.declarations()) {
      if (declaration.secret) continue;
      const row = (await this.settings.overrides(declaration.key)).find(
        (override) => override.scope === 'tenant',
      );
      if (row) {
        out.push({
          key: declaration.key,
          value: row.value ?? null,
          rollout: row.rollout ?? null,
          rules: rulesOut(row.rules as unknown as Rule[], names),
        });
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async preview(
    incoming: Settings,
    bundle: Readonly<Record<string, unknown>>,
  ): Promise<SectionPreview> {
    const target = await this.export();
    const bundled = rolesContentsSchema.safeParse(bundle.roles);
    const roleNames = new Set([
      ...(await this.roles.list()).map((role) => role.name),
      ...(bundled.success ? bundled.data.map((role) => role.name) : []),
    ]);
    const errors: NonNullable<SectionPreview['errors']> = [];
    const changes: SectionPreview['changes'] = [];
    for (const setting of incoming) {
      errors.push(
        ...this.check(setting, roleNames).map((message) => ({
          ref: setting.key,
          message,
        })),
      );
      const own = target.find((candidate) => candidate.key === setting.key);
      changes.push({
        ref: setting.key,
        action: !own
          ? 'create'
          : canonicalJson(own) === canonicalJson(setting)
            ? 'unchanged'
            : 'update',
      });
    }
    const keys = new Set(incoming.map((setting) => setting.key));
    return {
      errors,
      changes,
      touched: target.filter((setting) => keys.has(setting.key)),
    };
  }

  async import(
    actor: Principal,
    incoming: Settings,
    { changes, ip }: { changes: SectionPreview['changes']; ip?: string },
  ) {
    // After the roles section: a role the bundle brought has its id now.
    const ids = new Map(
      (await this.roles.list()).map((role) => [role.name, role.id]),
    );
    for (const setting of incoming) {
      if (
        changes.find((change) => change.ref === setting.key)?.action ===
        'unchanged'
      ) {
        continue;
      }
      await this.settings.set(
        actor,
        setting.key,
        {
          scope: 'tenant',
          ...(setting.value !== null && { value: setting.value }),
          rollout: setting.rollout,
          rules: rulesIn(setting.rules, ids) as never,
        },
        ip,
      );
    }
  }

  /** The target's declaration takes the setting: declared, its value, a rollout or rules only on a flag. */
  private check(setting: Settings[number], roleNames: ReadonlySet<string>) {
    const declaration = this.settings
      .declarations()
      .find((declared) => declared.key === setting.key);
    if (!declaration) {
      return [
        'Not declared here: the module that declares it is not deployed.',
      ];
    }
    if (
      declaration.secret ||
      !(declaration.scopes ?? ['tenant']).includes('tenant')
    ) {
      return ['Not set for a whole tenant here.'];
    }
    const issues: string[] = [];
    if (setting.value !== null) {
      const parsed = declaration.schema.safeParse(setting.value);
      if (!parsed.success) {
        issues.push(
          `The value is refused here: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
        );
      }
    }
    if (
      !declaration.flag &&
      (setting.rollout !== null || setting.rules.length > 0)
    ) {
      issues.push('A rollout or rules, but it is not a flag here.');
    }
    const used = roleNamesIn(setting.rules);
    const missing = used.filter((name) => !roleNames.has(name));
    if (missing.length) {
      issues.push(
        `No such role here, nor in the bundle: ${missing.join(', ')}.`,
      );
    }
    if (setting.rules.length) {
      // Checked with placeholder ids: the names are what the target maps.
      const parsed = parseRules(
        rulesIn(
          setting.rules,
          new Map(used.map((name) => [name, PLACEHOLDER_ID])),
        ),
        'tenant',
      );
      if (!parsed.ok) {
        issues.push(...parsed.issues.map((issue) => issue.message));
      }
    }
    return issues;
  }
}

const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

const isRoleCondition = (condition: unknown): condition is Rule =>
  !!condition && (condition as Rule).key === 'role';

const conditionsOf = (rule: Rule) =>
  Array.isArray(rule.conditions) ? (rule.conditions as unknown[]) : [];

/** A rule's role ids as role names (export). */
function rulesOut(rules: Rule[], names: ReadonlyMap<string, string>): Rule[] {
  return rules.map((rule) => ({
    ...rule,
    conditions: conditionsOf(rule).map((condition) => {
      if (!isRoleCondition(condition)) return condition;
      const params = (condition.params ?? {}) as { roleIds?: string[] };
      return {
        key: 'role',
        params: {
          roleNames: (params.roleIds ?? []).map((id) => names.get(id) ?? id),
        },
      };
    }),
  }));
}

/** A rule's role names as this tenant's role ids (apply). */
function rulesIn(rules: Rule[], ids: ReadonlyMap<string, string>): Rule[] {
  return rules.map((rule) => ({
    ...rule,
    conditions: conditionsOf(rule).map((condition) => {
      if (!isRoleCondition(condition)) return condition;
      const params = (condition.params ?? {}) as { roleNames?: string[] };
      return {
        key: 'role',
        params: {
          roleIds: (params.roleNames ?? []).map(
            (name) => ids.get(name) ?? name,
          ),
        },
      };
    }),
  }));
}

const roleNamesIn = (rules: Rule[]) =>
  rules.flatMap((rule) =>
    conditionsOf(rule)
      .filter(isRoleCondition)
      .flatMap(
        (condition) =>
          ((condition.params ?? {}) as { roleNames?: string[] }).roleNames ??
          [],
      ),
  );
