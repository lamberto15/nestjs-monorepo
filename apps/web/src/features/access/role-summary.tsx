import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import {
  actionKey,
  type Catalog,
  type CatalogAction,
  type CatalogSubject,
  type Change,
  type EditorState,
  type Rule,
} from '@/features/access/permissions';

/**
 * The records an action covers, in words: its rules' conditions (all of a
 * rule's, any rule's), or undefined when a rule covers every record.
 */
export function recordsText(
  t: TFunction<'access'>,
  action: CatalogAction,
  rules: readonly Rule[],
): string | undefined {
  if (rules.some((rule) => Object.keys(rule.conditions).length === 0)) {
    return undefined;
  }
  return rules
    .map((rule) =>
      action.conditions
        .filter((condition) => condition.key in rule.conditions)
        .map((condition) =>
          condition.input
            ? t('roles.summary.param', {
                label: condition.label,
                value: rule.conditions[condition.key]?.trim(),
              })
            : condition.label,
        )
        .join(t('roles.summary.and')),
    )
    .join(t('roles.summary.or'));
}

/** How a granted action is narrowed, in words (records, fields), or undefined. */
function narrowingText(
  t: TFunction<'access'>,
  subject: CatalogSubject,
  action: CatalogAction,
  rules: readonly Rule[],
): string | undefined {
  const parts: string[] = [];
  const records = recordsText(t, action, rules);
  if (records) parts.push(records);
  if (subject.fields.length > 0 && rules.every((rule) => rule.fields)) {
    const chosen = new Set(rules.flatMap((rule) => rule.fields ?? []));
    parts.push(
      chosen.size === 0
        ? t('roles.summary.noFields')
        : t('roles.summary.someFields', {
            count: chosen.size,
            total: subject.fields.length,
          }),
    );
  }
  return parts.length > 0
    ? parts.join(t('roles.summary.separator'))
    : undefined;
}

/** An action as the summary says it: its label, and how it is narrowed. */
function actionText(
  t: TFunction<'access'>,
  subject: CatalogSubject,
  action: CatalogAction,
  rules: readonly Rule[] | undefined,
) {
  const narrowing = rules && narrowingText(t, subject, action, rules);
  return narrowing
    ? t('roles.summary.narrowed', { action: action.label, narrowing })
    : action.label;
}

/**
 * What the role grants in plain words, built from the catalog's labels and
 * the edited state, and what saving would change against the saved role.
 */
export function RoleSummary(props: {
  catalog: Catalog;
  value: EditorState;
  /** The role grants everything (`all.manage`, Administrator). */
  everything: boolean;
  role: string;
  changes: Change[];
  /** The role's own fields that were edited. */
  edited: ('name' | 'description')[];
}) {
  const { t } = useTranslation('access');
  const canId = useId();
  const cannotId = useId();
  const changesId = useId();
  const can: { key: string; text: string }[] = [];
  const cannot: { key: string; text: string }[] = [];
  for (const subject of props.catalog.subjects) {
    const missing: string[] = [];
    for (const action of subject.actions) {
      const key = actionKey(subject.subject, action.action);
      const rules = props.value[key];
      if (props.everything || rules) {
        can.push({ key, text: actionText(t, subject, action, rules) });
      } else {
        missing.push(action.label);
      }
    }
    if (missing.length > 0) {
      cannot.push({ key: subject.subject, text: missing.join(', ') });
    }
  }
  const count = props.changes.length + props.edited.length;
  const sign = { granted: '+', revoked: '−', changed: '~' } as const;
  return (
    <aside
      aria-label={t('roles.summary.title')}
      className="flex flex-col gap-5 rounded-lg border p-4 text-sm"
    >
      <section aria-labelledby={canId} className="flex flex-col gap-2">
        <h2 id={canId} className="font-medium">
          {t('roles.summary.can', {
            role: props.role.trim() || t('roles.summary.thisRole'),
          })}
        </h2>
        {props.everything ? (
          <p>{t('roles.everything')}</p>
        ) : can.length === 0 ? (
          <p className="text-muted-foreground">{t('roles.summary.nothing')}</p>
        ) : (
          <ul className="flex list-disc flex-col gap-1 ps-5">
            {can.map((item) => (
              <li key={item.key}>{item.text}</li>
            ))}
          </ul>
        )}
      </section>
      {!props.everything && (
        <section aria-labelledby={cannotId} className="flex flex-col gap-2">
          <h2 id={cannotId} className="font-medium">
            {t('roles.summary.cannot')}
          </h2>
          {cannot.length === 0 ? (
            <p className="text-muted-foreground">
              {t('roles.summary.nothingElse')}
            </p>
          ) : (
            <ul className="flex list-disc flex-col gap-1 ps-5">
              {cannot.map((item) => (
                <li key={item.key}>{item.text}</li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section aria-labelledby={changesId} className="flex flex-col gap-2">
        <h2 id={changesId} className="font-medium">
          {t('roles.summary.changes', { count })}
        </h2>
        {count === 0 ? (
          <p className="text-muted-foreground">
            {t('roles.summary.noChanges')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {props.edited.map((field) => (
              <li key={field} className="flex gap-2">
                <span aria-hidden className="w-3 shrink-0 font-mono">
                  ~
                </span>
                <span>
                  <span className="sr-only">
                    {t('roles.summary.changed')}:{' '}
                  </span>
                  {t(
                    field === 'name'
                      ? 'roles.summary.name'
                      : 'roles.summary.descriptionField',
                  )}
                </span>
              </li>
            ))}
            {props.changes.map((change) => (
              <li key={change.key} className="flex gap-2">
                <span aria-hidden className="w-3 shrink-0 font-mono">
                  {sign[change.kind]}
                </span>
                <span>
                  <span className="sr-only">
                    {t(`roles.summary.${change.kind}`)}:{' '}
                  </span>
                  {change.kind === 'revoked'
                    ? change.action.label
                    : actionText(
                        t,
                        change.subject,
                        change.action,
                        props.value[change.key],
                      )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
