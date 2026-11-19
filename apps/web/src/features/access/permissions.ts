import type { GetResponse } from '@nestjs-monorepo/api-client';
import type { RoleBody } from '@/features/access/api';

/**
 * The role editor's model: `GET /v1/access/catalog` and a role's stored
 * permissions turned into what the editor shows, and back into the body of
 * `POST /v1/access/roles` / `PATCH /v1/access/roles/{id}`
 * (docs/permissions.md, "Roles and grants").
 *
 * The API's rules this follows:
 * - A permission is one action on one subject. Its `conditions` all have to
 *   hold (AND); several permissions of the same action widen it (OR). So an
 *   action holds a list of rules, each a permission of its own.
 * - A rule without conditions covers every record.
 * - A condition with an `input` takes one parameter, `{ [input.name]: value }`;
 *   `cents` is an integer amount in minor units.
 * - `fields` only for a subject that declares restrictable fields: left out
 *   grants all of them, `[]` none of them, a list only those.
 */

/** `GET /v1/access/catalog`: every subject, its actions and their conditions. */
export type Catalog = GetResponse<'/v1/access/catalog'>;
export type CatalogSubject = Catalog['subjects'][number];
export type CatalogAction = CatalogSubject['actions'][number];
export type CatalogCondition = CatalogAction['conditions'][number];

/** A permission as the access API returns it (a role's). */
export type Permission =
  GetResponse<'/v1/access/roles'>['items'][number]['permissions'][number];

/** A permission as a role's request body takes it: `fields` left out for all. */
export type RequestPermission = RoleBody['permissions'][number];

/** One permission of an action: its conditions (all must hold) and fields. */
export interface Rule {
  /** The conditions ticked, by key, with the parameter's text if it takes one. */
  conditions: Record<string, string>;
  /** null: every restrictable field; a list: only those. */
  fields: string[] | null;
}

/** The rules of each granted action, by `Subject.action`. Absent: not granted. */
export type EditorState = Record<string, Rule[]>;

export const actionKey = (subject: string, action: string) =>
  `${subject}.${action}`;

export const emptyRule = (): Rule => ({ conditions: {}, fields: null });

function findAction(catalog: Catalog, subject: string, action: string) {
  const s = catalog.subjects.find((item) => item.subject === subject);
  return { subject: s, action: s?.actions.find((a) => a.action === action) };
}

/** A parameter as the editor's text. */
function paramText(
  condition: CatalogCondition,
  params: Record<string, unknown> | undefined,
): string {
  if (!condition.input) return '';
  const value = params?.[condition.input.name];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

/**
 * A role's permissions as the editor's state. Permissions the catalog no
 * longer knows (a removed feature, `all.manage` of Administrator) come back
 * in `unknown`: the editor shows them, and saving drops them.
 */
export function fromPermissions(
  catalog: Catalog,
  permissions: readonly Permission[],
): { state: EditorState; unknown: Permission[] } {
  const state: EditorState = {};
  const unknown: Permission[] = [];
  const seen = new Set<string>();
  for (const permission of permissions) {
    const found = findAction(catalog, permission.subject, permission.action);
    if (!found.subject || !found.action) {
      unknown.push(permission);
      continue;
    }
    const conditions: Record<string, string> = {};
    for (const condition of permission.conditions) {
      const declared = found.action.conditions.find(
        (c) => c.key === condition.key,
      );
      if (declared) {
        conditions[condition.key] = paramText(declared, condition.params);
      }
    }
    const rule: Rule = {
      conditions,
      fields:
        found.subject.fields.length > 0 && Array.isArray(permission.fields)
          ? [...permission.fields]
          : null,
    };
    const key = actionKey(permission.subject, permission.action);
    // The same permission twice grants nothing more: one rule.
    const signature = `${key}|${ruleSignature(rule)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    (state[key] ??= []).push(rule);
  }
  return { state, unknown };
}

function ruleSignature(rule: Rule): string {
  return JSON.stringify([
    Object.entries(rule.conditions).toSorted(([a], [b]) => a.localeCompare(b)),
    rule.fields ? rule.fields.toSorted() : null,
  ]);
}

/** What is wrong with a rule's parameter: an i18n key, or undefined. */
export function paramProblem(
  condition: CatalogCondition,
  text: string | undefined,
): 'roles.errors.paramRequired' | 'roles.errors.paramCents' | undefined {
  if (!condition.input || text === undefined) return undefined;
  if (text.trim() === '') return 'roles.errors.paramRequired';
  if (condition.input.type === 'cents' && !/^-?\d+$/.test(text.trim())) {
    return 'roles.errors.paramCents';
  }
  return undefined;
}

/** Whether every ticked condition has a valid parameter. */
export function isValid(catalog: Catalog, state: EditorState): boolean {
  return Object.entries(state).every(([key, rules]) => {
    const [subject = '', action = ''] = key.split('.');
    const found = findAction(catalog, subject, action);
    return rules.every((rule) =>
      Object.entries(rule.conditions).every(([conditionKey, text]) => {
        const declared = found.action?.conditions.find(
          (c) => c.key === conditionKey,
        );
        return declared !== undefined && !paramProblem(declared, text);
      }),
    );
  });
}

/**
 * The editor's state as the request's `permissions`: catalog order (subject,
 * action, condition, field), one permission per rule, duplicates dropped.
 */
export function toPermissions(
  catalog: Catalog,
  state: EditorState,
): RequestPermission[] {
  const permissions: RequestPermission[] = [];
  for (const subject of catalog.subjects) {
    for (const action of subject.actions) {
      const rules = state[actionKey(subject.subject, action.action)] ?? [];
      const seen = new Set<string>();
      for (const rule of rules) {
        const signature = ruleSignature(rule);
        if (seen.has(signature)) continue;
        seen.add(signature);
        const permission: RequestPermission = {
          subject: subject.subject,
          action: action.action,
          conditions: action.conditions
            .filter((condition) => condition.key in rule.conditions)
            .map((condition) => {
              const text = (rule.conditions[condition.key] ?? '').trim();
              if (!condition.input) return { key: condition.key };
              return {
                key: condition.key,
                params: {
                  [condition.input.name]:
                    condition.input.type === 'cents' ? Number(text) : text,
                },
              };
            }),
        };
        if (subject.fields.length > 0 && rule.fields !== null) {
          const chosen = new Set(rule.fields);
          permission.fields = subject.fields
            .filter((field) => chosen.has(field.field))
            .map((field) => field.field);
        }
        permissions.push(permission);
      }
    }
  }
  return permissions;
}

/** Whether two lists of rules grant the same (order and repeats aside). */
export function sameRules(a: readonly Rule[] = [], b: readonly Rule[] = []) {
  const signature = (rules: readonly Rule[]) =>
    [...new Set(rules.map(ruleSignature))].toSorted().join('\n');
  return signature(a) === signature(b);
}

/**
 * Whether an action's rules fit the editor's simple controls: one rule with
 * at most one condition. Anything more is edited rule by rule.
 */
export function isSimple(rules: readonly Rule[]): boolean {
  return rules.length === 1 && Object.keys(rules[0]!.conditions).length <= 1;
}

/** Whether every rule has a condition: the action covers only some records. */
export const onSomeRecords = (rules: readonly Rule[] = []) =>
  rules.length > 0 &&
  rules.every((rule) => Object.keys(rule.conditions).length > 0);

/** An action that differs from the saved role, and how. */
export interface Change {
  key: string;
  subject: CatalogSubject;
  action: CatalogAction;
  kind: 'granted' | 'revoked' | 'changed';
}

/** What differs between the saved state and the edited one, in catalog order. */
export function changesOf(
  catalog: Catalog,
  saved: EditorState,
  current: EditorState,
): Change[] {
  const changes: Change[] = [];
  for (const subject of catalog.subjects) {
    for (const action of subject.actions) {
      const key = actionKey(subject.subject, action.action);
      const before = saved[key];
      const after = current[key];
      if (sameRules(before, after)) continue;
      const kind = !before ? 'granted' : !after ? 'revoked' : 'changed';
      changes.push({ key, subject, action, kind });
    }
  }
  return changes;
}
