import { Badge } from '@nestjs-monorepo/ui/components/badge';
import { Button } from '@nestjs-monorepo/ui/components/button';
import { Checkbox } from '@nestjs-monorepo/ui/components/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@nestjs-monorepo/ui/components/collapsible';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@nestjs-monorepo/ui/components/field';
import { Input } from '@nestjs-monorepo/ui/components/input';
import { Label } from '@nestjs-monorepo/ui/components/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@nestjs-monorepo/ui/components/popover';
import {
  RadioGroup,
  RadioGroupItem,
} from '@nestjs-monorepo/ui/components/radio-group';
import { Switch } from '@nestjs-monorepo/ui/components/switch';
import { cn } from '@nestjs-monorepo/ui/lib/utils';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  InfoIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  actionKey,
  emptyRule,
  isSimple,
  onSomeRecords,
  paramProblem,
  sameRules,
  type Catalog,
  type CatalogAction,
  type CatalogCondition,
  type CatalogSubject,
  type EditorState,
  type Rule,
} from '@/features/access/permissions';
import { useDescribedBy } from '@/lib/form';

/** Which subjects and actions the editor lists. */
type Show = 'all' | 'granted' | 'changed';

/** The value of "Every record" among the conditions (a key never starts with `*`). */
const EVERY = '*';

interface EditorProps {
  catalog: Catalog;
  value: EditorState;
  /** The role as saved: what "Changed" is measured against. */
  saved: EditorState;
  onChange: (value: EditorState) => void;
  disabled?: boolean;
  /** Whether the editor's user holds an action (`me.can`): one can't grant what one lacks. */
  holds: (key: string) => boolean;
}

/**
 * The permissions of a role, generated from `GET /v1/access/catalog`: the
 * subjects on one side (how much of each is granted), the chosen subject's
 * actions on the other, each a switch. A granted action that may be narrowed
 * says which records (every one, or one condition) and which fields; what
 * that can't express (several rules, any of which grants it, or several
 * conditions that must all hold) is edited rule by rule under "Advanced".
 */
export function PermissionEditor(props: EditorProps & { subject?: string }) {
  const { t } = useTranslation('access');
  const filterId = useId();
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [selected, setSelected] = useState(props.subject);
  const needle = query.trim().toLowerCase();
  const matches = (...texts: string[]) =>
    texts.some((text) => text.toLowerCase().includes(needle));
  const actionsShown = (subject: CatalogSubject) =>
    subject.actions.filter((action) => {
      const key = actionKey(subject.subject, action.action);
      if (show === 'granted' && !props.value[key]) return false;
      if (show === 'changed' && sameRules(props.saved[key], props.value[key])) {
        return false;
      }
      return (
        needle === '' ||
        matches(subject.label, subject.subject, action.label, key)
      );
    });
  const subjects = props.catalog.subjects.filter(
    (subject) => actionsShown(subject).length > 0,
  );
  // A subject the filter hides gives way to the first one it shows.
  const current =
    subjects.find((subject) => subject.subject === selected) ?? subjects[0];
  const filters: { value: Show; label: string }[] = [
    { value: 'all', label: t('roles.editor.showAll') },
    { value: 'granted', label: t('roles.editor.showGranted') },
    { value: 'changed', label: t('roles.editor.showChanged') },
  ];
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        <Field>
          <FieldLabel htmlFor={filterId} className="sr-only">
            {t('roles.editor.filter')}
          </FieldLabel>
          <Input
            id={filterId}
            type="search"
            placeholder={t('roles.editor.filter')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>
        <div
          role="group"
          aria-label={t('roles.editor.show')}
          className="flex flex-wrap gap-1"
        >
          {filters.map((filter) => (
            <Button
              key={filter.value}
              type="button"
              size="sm"
              variant={show === filter.value ? 'secondary' : 'ghost'}
              aria-pressed={show === filter.value}
              onClick={() => setShow(filter.value)}
            >
              {filter.label}
            </Button>
          ))}
        </div>
        <ul
          aria-label={t('roles.editor.subjects')}
          className="flex flex-col gap-0.5 overflow-y-auto max-lg:max-h-72"
        >
          {subjects.map((subject) => (
            <li key={subject.subject}>
              <SubjectButton
                subject={subject}
                value={props.value}
                current={subject === current}
                onSelect={() => setSelected(subject.subject)}
              />
            </li>
          ))}
        </ul>
      </div>
      {current ? (
        <SubjectPanel
          {...props}
          key={current.subject}
          subject={current}
          actions={actionsShown(current)}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('roles.editor.noMatch')}
        </p>
      )}
    </div>
  );
}

const grantedOf = (subject: CatalogSubject, value: EditorState) =>
  subject.actions.filter(
    (action) => value[actionKey(subject.subject, action.action)] !== undefined,
  );

function SubjectButton(props: {
  subject: CatalogSubject;
  value: EditorState;
  current: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('access');
  const { subject } = props;
  const granted = grantedOf(subject, props.value).length;
  const total = subject.actions.length;
  return (
    <button
      type="button"
      aria-current={props.current ? 'true' : undefined}
      onClick={props.onSelect}
      className={cn(
        'flex w-full flex-col gap-1.5 rounded-md px-2.5 py-2 text-start text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
        props.current && 'bg-muted font-medium',
      )}
    >
      <span className="flex w-full items-center justify-between gap-3">
        <span className="min-w-0 truncate">{subject.label}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
          {granted === 0
            ? t('roles.editor.countNone', { total })
            : t('roles.editor.count', { granted, total })}
        </span>
      </span>
      <span aria-hidden className="block h-1 w-full rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${Math.round((granted / total) * 100)}%` }}
        />
      </span>
    </button>
  );
}

function SubjectPanel(
  props: EditorProps & { subject: CatalogSubject; actions: CatalogAction[] },
) {
  const { t } = useTranslation('access');
  const titleId = useId();
  const { subject } = props;
  const granted = grantedOf(subject, props.value);
  const some = granted.filter((action) =>
    onSomeRecords(props.value[actionKey(subject.subject, action.action)]),
  ).length;
  const summary = t(
    some > 0 ? 'roles.editor.summarySome' : 'roles.editor.summary',
    { granted: granted.length, count: subject.actions.length, some },
  );
  // Granting only what one holds; taking away is always offered.
  const grantable = subject.actions.filter((action) => {
    const key = actionKey(subject.subject, action.action);
    return props.value[key] === undefined && props.holds(key);
  });
  const update = (change: (copy: EditorState) => void) => {
    const copy = { ...props.value };
    change(copy);
    props.onChange(copy);
  };
  return (
    <section
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col rounded-lg border"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={titleId} className="text-base font-medium">
            {subject.label}{' '}
            <code className="ms-1 text-xs font-normal text-muted-foreground">
              {subject.subject}
            </code>
          </h3>
          <p className="text-sm text-muted-foreground">{summary}</p>
        </div>
        {!props.disabled && (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={grantable.length === 0}
              onClick={() =>
                update((copy) => {
                  for (const action of grantable) {
                    copy[actionKey(subject.subject, action.action)] = [
                      emptyRule(),
                    ];
                  }
                })
              }
            >
              {t('roles.editor.grantAll')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={granted.length === 0}
              onClick={() =>
                update((copy) => {
                  for (const action of subject.actions) {
                    delete copy[actionKey(subject.subject, action.action)];
                  }
                })
              }
            >
              {t('roles.editor.clear')}
            </Button>
          </div>
        )}
      </header>
      <ul className="divide-y">
        {props.actions.map((action) => (
          <li key={action.action}>
            <ActionRow {...props} action={action} />
          </li>
        ))}
      </ul>
      <p className="flex items-start gap-2 border-t p-4 text-sm text-muted-foreground">
        <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        {t('roles.editor.holdsHint')}
      </p>
    </section>
  );
}

function ActionRow(
  props: EditorProps & { subject: CatalogSubject; action: CatalogAction },
) {
  const { t } = useTranslation('access');
  const { subject, action } = props;
  const key = actionKey(subject.subject, action.action);
  const rules = props.value[key];
  const granted = rules !== undefined && rules.length > 0;
  const held = props.holds(key);
  const changed = !sameRules(props.saved[key], rules);
  const id = `perm-${key}`;
  const setRules = (next: Rule[] | undefined) => {
    const copy = { ...props.value };
    if (next && next.length > 0) {
      copy[key] = next;
    } else {
      delete copy[key];
    }
    props.onChange(copy);
  };
  const configurable =
    action.conditions.length > 0 || subject.fields.length > 0;
  return (
    <div className="flex flex-col gap-3 p-4">
      <Field orientation="horizontal">
        <Switch
          id={id}
          checked={granted}
          disabled={props.disabled || (!granted && !held)}
          onCheckedChange={(checked) =>
            setRules(checked ? [emptyRule()] : undefined)
          }
        />
        <FieldContent>
          <div className="flex flex-wrap items-center gap-2">
            <FieldLabel htmlFor={id}>
              {action.label}
              <code className="text-xs font-normal text-muted-foreground">
                {key}
              </code>
            </FieldLabel>
            {changed && (
              <Badge variant="outline">{t('roles.editor.changed')}</Badge>
            )}
          </div>
          {!held && (
            <FieldDescription>{t('roles.editor.notHeld')}</FieldDescription>
          )}
        </FieldContent>
      </Field>
      {granted && configurable && (
        <Scope
          ruleKey={key}
          rules={rules}
          action={action}
          subject={subject}
          disabled={props.disabled}
          onChange={setRules}
        />
      )}
    </div>
  );
}

/**
 * Which records and fields a granted action covers: one choice of records
 * and a field picker while it is one rule with at most one condition, its
 * rules one by one otherwise (and on demand).
 */
function Scope(props: {
  ruleKey: string;
  rules: Rule[];
  action: CatalogAction;
  subject: CatalogSubject;
  disabled?: boolean;
  onChange: (rules: Rule[]) => void;
}) {
  const { t } = useTranslation('access');
  const [advanced, setAdvanced] = useState(false);
  const { rules, action, subject } = props;
  const simple = isSimple(rules);
  const rule = rules[0]!;
  const setRule = (next: Rule) => props.onChange([next]);
  const editor = <RulesEditor {...props} />;
  return (
    <div className="flex flex-col gap-3 ps-11">
      {simple ? (
        <>
          {action.conditions.length > 0 && (
            <RecordsChoice
              ruleKey={props.ruleKey}
              rule={rule}
              action={action}
              disabled={props.disabled}
              onChange={setRule}
            />
          )}
          {subject.fields.length > 0 && (
            <FieldsPicker
              ruleKey={props.ruleKey}
              rule={rule}
              subject={subject}
              disabled={props.disabled}
              onChange={setRule}
            />
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('roles.editor.advancedHint')}
        </p>
      )}
      {!simple
        ? editor
        : action.conditions.length > 0 && (
            <Collapsible open={advanced} onOpenChange={setAdvanced}>
              <CollapsibleTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="-ms-2"
                  />
                }
              >
                {advanced ? <ChevronDownIcon /> : <ChevronRightIcon />}
                {t('roles.editor.advanced')}
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">{editor}</CollapsibleContent>
            </Collapsible>
          )}
    </div>
  );
}

/** "Which records": every record, or one of the catalog's conditions. */
function RecordsChoice(props: {
  ruleKey: string;
  rule: Rule;
  action: CatalogAction;
  disabled?: boolean;
  onChange: (rule: Rule) => void;
}) {
  const { t } = useTranslation('access');
  const { rule, action } = props;
  const base = `scope-${props.ruleKey}`;
  const chosen = Object.keys(rule.conditions)[0];
  const condition = action.conditions.find((c) => c.key === chosen);
  const options = [
    { value: EVERY, label: t('roles.editor.everyRecordOption') },
    ...action.conditions.map((c) => ({ value: c.key, label: c.label })),
  ];
  const text = chosen === undefined ? undefined : rule.conditions[chosen];
  return (
    <div className="flex flex-col gap-2">
      <span id={`${base}-records`} className="text-sm font-medium">
        {t('roles.editor.whichRecords')}
      </span>
      <div className="flex flex-wrap items-start gap-3">
        <RadioGroup
          aria-labelledby={`${base}-records`}
          value={chosen ?? EVERY}
          disabled={props.disabled}
          onValueChange={(value) =>
            props.onChange({
              ...rule,
              conditions: value === EVERY ? {} : { [value as string]: '' },
            })
          }
          className="flex w-auto flex-wrap gap-1 rounded-lg bg-muted p-1"
        >
          {options.map((option) => {
            const id = `${base}-${option.value === EVERY ? 'every' : option.value}`;
            return (
              <div
                key={option.value}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 has-data-checked:bg-background has-data-checked:shadow-sm"
              >
                <RadioGroupItem id={id} value={option.value} />
                <Label htmlFor={id} className="font-normal">
                  {option.label}
                </Label>
              </div>
            );
          })}
        </RadioGroup>
        {condition?.input && (
          <ConditionParam
            id={`${base}-${condition.key}-param`}
            className="min-w-40"
            input={condition.input}
            value={text ?? ''}
            problem={paramProblem(condition, text)}
            disabled={props.disabled}
            onChange={(next) =>
              props.onChange({ ...rule, conditions: { [condition.key]: next } })
            }
          />
        )}
      </div>
      {condition && (
        <p className="text-xs text-muted-foreground">{condition.description}</p>
      )}
    </div>
  );
}

/** "Fields": all of the subject's restrictable fields, or a chosen few. */
function FieldsPicker(props: {
  ruleKey: string;
  rule: Rule;
  subject: CatalogSubject;
  disabled?: boolean;
  onChange: (rule: Rule) => void;
}) {
  const { t } = useTranslation('access');
  const { rule, subject } = props;
  const base = `scope-${props.ruleKey}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span id={`${base}-fields`} className="text-sm font-medium">
        {t('roles.editor.fields')}
      </span>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              id={`${base}-fields-trigger`}
              aria-labelledby={`${base}-fields ${base}-fields-trigger`}
            />
          }
        >
          {rule.fields === null
            ? t('roles.editor.fieldsAll')
            : t('roles.editor.fieldsSome', {
                count: rule.fields.length,
                total: subject.fields.length,
              })}
          <ChevronDownIcon />
        </PopoverTrigger>
        <PopoverContent align="start">
          <FieldsEditor
            base={`${base}-picker`}
            subject={subject}
            rule={rule}
            disabled={props.disabled}
            onChange={props.onChange}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** An action's rules one by one: any of them grants it. */
function RulesEditor(props: {
  ruleKey: string;
  rules: Rule[];
  action: CatalogAction;
  subject: CatalogSubject;
  disabled?: boolean;
  onChange: (rules: Rule[]) => void;
}) {
  const { t } = useTranslation('access');
  const { rules } = props;
  return (
    <div className="flex flex-col gap-3 border-s ps-4">
      {rules.map((rule, index) => (
        <RuleEditor
          // Rules have no identity of their own: their place is theirs.
          key={index}
          index={index}
          ruleKey={props.ruleKey}
          rule={rule}
          action={props.action}
          subject={props.subject}
          disabled={props.disabled}
          removable={rules.length > 1}
          onChange={(next) =>
            props.onChange(rules.map((r, i) => (i === index ? next : r)))
          }
          onRemove={() => props.onChange(rules.filter((_, i) => i !== index))}
        />
      ))}
      {props.action.conditions.length > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={props.disabled}
          onClick={() => props.onChange([...rules, emptyRule()])}
        >
          <PlusIcon />
          {t('roles.editor.addRule')}
        </Button>
      )}
    </div>
  );
}

function RuleEditor(props: {
  index: number;
  ruleKey: string;
  rule: Rule;
  action: CatalogAction;
  subject: CatalogSubject;
  disabled?: boolean;
  removable: boolean;
  onChange: (rule: Rule) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('access');
  const { rule, action, subject } = props;
  const base = `rule-${props.ruleKey}-${props.index}`;
  const ticked = Object.keys(rule.conditions);
  return (
    <div
      className="flex flex-col gap-3 rounded-md bg-muted/40 p-3"
      role="group"
      aria-label={t('roles.editor.rule', { n: props.index + 1 })}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">
          {t('roles.editor.rule', { n: props.index + 1 })}
        </span>
        {props.removable && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ms-auto"
            aria-label={t('roles.editor.removeRule')}
            disabled={props.disabled}
            onClick={props.onRemove}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
      {action.conditions.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {ticked.length === 0
              ? t('roles.editor.everyRecord')
              : t('roles.editor.allOf')}
          </p>
          {action.conditions.map((condition) => {
            const id = `${base}-${condition.key}`;
            const on = condition.key in rule.conditions;
            const text = rule.conditions[condition.key];
            const problem = on ? paramProblem(condition, text) : undefined;
            return (
              <div key={condition.key} className="flex flex-col gap-1">
                <Field orientation="horizontal">
                  <Checkbox
                    id={id}
                    checked={on}
                    disabled={props.disabled}
                    onCheckedChange={(checked) => {
                      const conditions = { ...rule.conditions };
                      if (checked) {
                        conditions[condition.key] = '';
                      } else {
                        delete conditions[condition.key];
                      }
                      props.onChange({ ...rule, conditions });
                    }}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={id}>{condition.label}</FieldLabel>
                    <FieldDescription>{condition.description}</FieldDescription>
                  </FieldContent>
                </Field>
                {on && condition.input && (
                  <ConditionParam
                    id={`${id}-param`}
                    input={condition.input}
                    value={text ?? ''}
                    problem={problem}
                    disabled={props.disabled}
                    onChange={(next) =>
                      props.onChange({
                        ...rule,
                        conditions: {
                          ...rule.conditions,
                          [condition.key]: next,
                        },
                      })
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {subject.fields.length > 0 && (
        <FieldsEditor
          base={base}
          subject={subject}
          rule={rule}
          disabled={props.disabled}
          onChange={props.onChange}
        />
      )}
    </div>
  );
}

/** A condition's parameter; the amount's hint and what is wrong with it describe the input. */
function ConditionParam(props: {
  id: string;
  className?: string;
  input: NonNullable<CatalogCondition['input']>;
  value: string;
  problem: ReturnType<typeof paramProblem>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('access');
  const { input, problem } = props;
  const { descriptionId, errorId, describedBy } = useDescribedBy(
    input.type === 'cents',
    problem !== undefined,
  );
  return (
    <Field
      data-invalid={problem !== undefined}
      className={props.className ?? 'ms-6'}
    >
      <FieldLabel htmlFor={props.id}>{input.label}</FieldLabel>
      <Input
        id={props.id}
        inputMode={input.type === 'cents' ? 'numeric' : 'text'}
        value={props.value}
        disabled={props.disabled}
        aria-invalid={problem !== undefined}
        aria-describedby={describedBy}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {input.type === 'cents' && (
        <FieldDescription id={descriptionId}>
          {t('roles.editor.cents')}
        </FieldDescription>
      )}
      {problem && <FieldError id={errorId}>{t(problem)}</FieldError>}
    </Field>
  );
}

function FieldsEditor(props: {
  base: string;
  subject: CatalogSubject;
  rule: Rule;
  disabled?: boolean;
  onChange: (rule: Rule) => void;
}) {
  const { t } = useTranslation('access');
  const { rule, subject } = props;
  const allId = `${props.base}-fields-all`;
  const all = rule.fields === null;
  return (
    <div className="flex flex-col gap-2">
      <Field orientation="horizontal">
        <Checkbox
          id={allId}
          checked={all}
          disabled={props.disabled}
          onCheckedChange={(checked) =>
            props.onChange({
              ...rule,
              // Narrowing starts from every field, so nothing vanishes at once.
              fields: checked ? null : subject.fields.map((f) => f.field),
            })
          }
        />
        <FieldContent>
          <FieldLabel htmlFor={allId}>{t('roles.editor.allFields')}</FieldLabel>
          <FieldDescription>
            {t('roles.editor.allFieldsHint', {
              fields: subject.fields.map((f) => f.label).join(', '),
            })}
          </FieldDescription>
        </FieldContent>
      </Field>
      {!all && (
        <div className="ms-6 flex flex-col gap-2">
          {subject.fields.map((field) => {
            const id = `${props.base}-field-${field.field}`;
            const chosen = rule.fields?.includes(field.field) ?? false;
            return (
              <Field key={field.field} orientation="horizontal">
                <Checkbox
                  id={id}
                  checked={chosen}
                  disabled={props.disabled}
                  onCheckedChange={(checked) =>
                    props.onChange({
                      ...rule,
                      fields: checked
                        ? [...(rule.fields ?? []), field.field]
                        : (rule.fields ?? []).filter((f) => f !== field.field),
                    })
                  }
                />
                <FieldLabel htmlFor={id}>
                  {field.label}
                  {field.sensitive && (
                    <Badge variant="outline">
                      {t('roles.editor.sensitive')}
                    </Badge>
                  )}
                </FieldLabel>
              </Field>
            );
          })}
          {rule.fields?.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t('roles.editor.noFields')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
