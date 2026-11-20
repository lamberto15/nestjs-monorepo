// The web app's part of the feature schematic (feature/index.js, with
// `--web-root`): features/<plural>/ (queries, form, delete hook, nav entry,
// test), routes/_app/<plural>/ (list, new, detail, edit) and
// locales/en/<plural>.json. Like the API's templates, each function takes the
// context (`t` the names, `fields`, `softDelete`, `addons`) and returns a
// file's text; Prettier formats it after. The pages are what a new feature
// starts from: the list on ListPage (`?bulkRun=<id>` narrows it to what a
// bulk run changed, the link of its notification), a form of the fields, the
// detail with RecordPanels (it shows the panels the record's add-ons have).
// Bulk actions, import, watching, favorites and the rest are added by hand.
import { ADDONS } from '../feature/addons.js';
import { titleField } from '../feature/fields.js';
import { names } from '../feature/names.js';

/** `dueOn` → `Due on`; `widgetId` → `Widget`: a field's label. */
export const label = (name) => {
  const words = name
    .replace(/Id$/, '')
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase();
  return words[0].toUpperCase() + words.slice(1);
};

const lines = (...parts) =>
  parts
    .flat(Infinity)
    .filter((part) => part !== false)
    .join('\n');
const cap = (word) => word[0].toUpperCase() + word.slice(1);
const quote = (text) => "'" + text + "'";

/** A TypeScript template literal; `@{` in `text` opens an interpolation of it. */
const tpl = (text) =>
  String.fromCharCode(96) +
  text.replaceAll('@{', '$' + '{') +
  String.fromCharCode(96);

/** The currency a new money field starts with (the user may change it). */
const DEFAULT_CURRENCY = 'EUR';

/** The form's inputs of a field: money has two. */
const keysOf = (f) =>
  f.type === 'money' ? [f.name + 'Amount', f.name + 'Currency'] : [f.name];

/** The paths (relative to apps/web/src) of a feature's web files. */
export function webPaths(t) {
  return {
    api: `features/${t.plural}/api.ts`,
    form: `features/${t.plural}/${t.singular}-form.tsx`,
    remove: `features/${t.plural}/use-${t.singular}-delete.tsx`,
    nav: `features/${t.plural}/nav.ts`,
    test: `features/${t.plural}/${t.plural}.test.tsx`,
    list: `routes/_app/${t.plural}/index.tsx`,
    new: `routes/_app/${t.plural}/new.tsx`,
    detail: `routes/_app/${t.plural}/$id/index.tsx`,
    edit: `routes/_app/${t.plural}/$id/edit.tsx`,
  };
}

/** Whether the records have a `number` column: the sequences add-on, but not for a `!numbered` field of their own. */
const numberColumn = (addons, fields) =>
  addons.includes('sequences') && !fields.some((f) => f.numbered);

/** The English texts of locales/<lng>/<plural>.json (every locale gets them, to translate). */
export function texts({ t, fields, softDelete, addons }) {
  const labels = {};
  if (numberColumn(addons, fields)) labels.number = 'Number';
  for (const f of fields) {
    labels[f.name] = label(f.name);
    if (f.type === 'money') {
      labels[`${f.name}Currency`] = `${label(f.name)} currency`;
    }
  }
  labels.createdAt = 'Created';
  labels.updatedAt = 'Updated';
  const enums = Object.fromEntries(
    fields
      .filter((f) => f.type === 'enum')
      .map((f) => [
        f.name,
        Object.fromEntries(f.values.map((v) => [v, label(v)])),
      ]),
  );
  const Noun = cap(t.noun);
  return {
    title: cap(t.nouns),
    nav: cap(t.nouns),
    fields: labels,
    ...(Object.keys(enums).length > 0 && { enums }),
    values: { yes: 'Yes', no: 'No' },
    new: { action: `New ${t.noun}`, title: `New ${t.noun}` },
    edit: { title: `Edit ${t.noun}` },
    form: {
      required: 'Fill in this field.',
      invalidWhole: 'Enter a whole number.',
      invalidDecimal: 'Enter a number such as 12.50.',
      invalidDate: 'Enter a date as YYYY-MM-DD.',
      invalidDateTime: 'Enter a date and time such as 2026-01-31T09:00:00Z.',
      invalidJson: 'Enter a JSON object.',
      invalidCurrency: 'Enter a three-letter currency code such as EUR.',
      create: `Create ${t.noun}`,
      save: 'Save changes',
      cancel: 'Cancel',
      created: `${Noun} created`,
      saved: `${Noun} saved`,
      conflict: `Someone else changed this ${t.noun}. Reload the page, then make your changes again.`,
      ...Object.fromEntries(
        fields
          .filter((f) => f.numbered)
          .map((f) => [
            `${f.name}Hint`,
            'Leave it empty to number it from its naming series.',
          ]),
      ),
      ...(addons.includes('sequences') && {
        numbering: 'Numbering',
        numberingHint: `Which series gives the ${t.noun} its number.`,
      }),
    },
    detail: { back: `Back to ${t.nouns}` },
    actions: {
      open: `Actions for this ${t.noun}`,
      view: 'View',
      edit: `Edit ${t.noun}`,
      delete: 'Delete',
      ...(softDelete && { restore: 'Restore' }),
    },
    delete: {
      title: `Delete this ${t.noun}?`,
      description: softDelete
        ? 'It moves to the recycle bin, where you can restore it until it is purged.'
        : 'It is deleted for good.',
      confirm: 'Delete',
      done: `${Noun} deleted`,
      ...(softDelete && { undo: 'Undo' }),
    },
    ...(softDelete && {
      restore: { done: `${Noun} restored` },
      bin: { label: 'Recycle bin', showing: `Showing deleted ${t.nouns}` },
    }),
    notFound: {
      title: `${Noun} not found`,
      description:
        'It may have been deleted, or you may not have access to it.',
    },
    error: {
      title: `The ${t.noun} could not be loaded`,
      generic: 'Something went wrong. Try again.',
      retry: 'Try again',
    },
  };
}

export function api({ t, softDelete }) {
  const S = t.Singular;
  const P = t.PLURAL;
  const item = t.singularCamel;
  const route = `/v1/${t.plural}`;
  return lines(
    `import { etagOf, unwrap, type paths } from '@nestjs-monorepo/api-client';`,
    `import { queryOptions } from '@tanstack/react-query';`,
    `import { api } from '@/lib/api';`,
    `import { recordKeys } from '@/lib/records';`,
    '',
    `/** The ${t.nouns} list route, as ListPage and the record keys name it. */`,
    `export const ${P}_PATH = '${route}';`,
    '',
    '/** Each record says what the user may do with it now (`can`, see useRecordCan). */',
    `export const ${P}_LIST_QUERY = { include: 'can' };`,
    softDelete &&
      `export const ${P}_BIN_QUERY = { ...${P}_LIST_QUERY, deleted: 'true' };`,
    '',
    `type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;`,
    '',
    `/** ${cap(t.aNoun)} as one reader sees it: a field is left out when their permissions do not include it. */`,
    `export type ${S} = Json<paths['${route}/{id}']['get']['responses'][200]>;`,
    `export type ${S}Create = NonNullable<paths['${route}']['post']['requestBody']>['content']['application/json'];`,
    `export type ${S}Changes = NonNullable<paths['${route}/{id}']['patch']['requestBody']>['content']['application/json'];`,
    '',
    `/** One ${t.noun} with the ETag it came with (its If-Match in the next write). */`,
    `const read${S} = async (id: string) => {`,
    `  const result = await api.GET('${route}/{id}', {`,
    `    params: { path: { id }, query: ${P}_LIST_QUERY },`,
    '  });',
    '  return {',
    `    ${item}: await unwrap(Promise.resolve(result)),`,
    '    etag: etagOf(result),',
    '  };',
    '};',
    '',
    `export const ${item}Query = (id: string) =>`,
    '  queryOptions({',
    `    queryKey: recordKeys.detail(${P}_PATH, id),`,
    `    queryFn: () => read${S}(id),`,
    '    // RecordState says a 404 or a failure on the page (with a retry): not a toast as well.',
    '    meta: { errorToast: false },',
    '  });',
    '',
    '/** The client sends the Idempotency-Key of every POST itself. */',
    `export const create${S} = (body: ${S}Create) =>`,
    `  unwrap(api.POST('${route}', { body }));`,
    '',
    `/** Only what is sent changes; with the ETag, a ${t.noun} changed meanwhile is a 412. */`,
    `export const update${S} = (id: string, body: ${S}Changes, etag?: string) =>`,
    '  unwrap(',
    `    api.PATCH('${route}/{id}', {`,
    '      params: {',
    '        path: { id },',
    `        ...(etag && { header: { 'If-Match': etag } }),`,
    '      },',
    '      body,',
    '    }),',
    '  );',
    '',
    `export const delete${S} = (id: string) =>`,
    `  unwrap(api.DELETE('${route}/{id}', { params: { path: { id } } }));`,
    softDelete && [
      '',
      `export const restore${S} = (id: string) =>`,
      `  unwrap(api.POST('${route}/{id}/restore', { params: { path: { id } } }));`,
    ],
  );
}

export function nav({ t }) {
  return lines(
    `import { FileTextIcon } from 'lucide-react';`,
    `import type { NavContribution } from '@/nav';`,
    '',
    'export default {',
    `  group: 'workspace',`,
    '  order: 200,',
    `  to: '/${t.plural}',`,
    `  label: '${t.plural}:nav',`,
    '  icon: FileTextIcon,',
    `  permission: '${t.Singular}.read',`,
    '} satisfies NavContribution;',
  );
}

/** The delete hook: useRecordDelete with its Undo for the recycle bin, else a plain confirmation. */
export function remove({ t, softDelete }) {
  const S = t.Singular;
  const P = t.PLURAL;
  const item = t.singularCamel;
  const ns = `useTranslation('${t.plural}')`;
  if (softDelete) {
    return lines(
      `import { useTranslation } from 'react-i18next';`,
      `import { useRecordDelete } from '@/components/records/use-record-delete';`,
      `import { ${P}_PATH, delete${S}, restore${S} } from './api';`,
      '',
      'type Target = { id: string };',
      '',
      `/** Delete ${t.aNoun} with a confirmation and an Undo toast; restore from the bin. */`,
      `export function use${S}Delete(options?: {`,
      `  onDeleted?: (${item}: Target) => void;`,
      `  onRestored?: (${item}: Target) => void;`,
      '}) {',
      `  const { t } = ${ns};`,
      '  return useRecordDelete<Target>({',
      `    path: ${P}_PATH,`,
      `    remove: (${item}) => delete${S}(${item}.id),`,
      `    restore: (${item}) => restore${S}(${item}.id),`,
      '    texts: {',
      `      title: t('delete.title'),`,
      `      description: t('delete.description'),`,
      `      confirm: t('delete.confirm'),`,
      `      deleted: t('delete.done'),`,
      `      undo: t('delete.undo'),`,
      `      restored: t('restore.done'),`,
      '    },',
      '    ...options,',
      '  });',
      '}',
    );
  }
  return lines(
    `import { useMutation, useQueryClient } from '@tanstack/react-query';`,
    `import { useCallback, useState } from 'react';`,
    `import { useTranslation } from 'react-i18next';`,
    `import { toast } from 'sonner';`,
    `import { ConfirmDialog } from '@/components/confirm-dialog';`,
    `import { recordKeys } from '@/lib/records';`,
    `import { ${P}_PATH, delete${S} } from './api';`,
    '',
    'type Target = { id: string };',
    '',
    `/** Delete ${t.aNoun} for good, after a confirmation (there is no recycle bin to undo from). */`,
    `export function use${S}Delete(options?: {`,
    `  onDeleted?: (${item}: Target) => void;`,
    '}) {',
    `  const { t } = ${ns};`,
    '  const queryClient = useQueryClient();',
    '  const [target, setTarget] = useState<Target | null>(null);',
    '  const removing = useMutation({',
    `    mutationFn: (${item}: Target) => delete${S}(${item}.id),`,
    '  });',
    `  const ask = useCallback((${item}: Target) => setTarget(${item}), []);`,
    '  const dialog = (',
    '    <ConfirmDialog',
    '      open={target !== null}',
    '      onOpenChange={(open) => !open && setTarget(null)}',
    `      title={t('delete.title')}`,
    `      description={t('delete.description')}`,
    `      confirm={t('delete.confirm')}`,
    '      onConfirm={async () => {',
    '        if (!target) return;',
    '        await removing.mutateAsync(target);',
    '        // The record is gone from its route: drop its query, do not refetch it into a 404.',
    `        queryClient.removeQueries({ queryKey: recordKeys.details(${P}_PATH) });`,
    `        await queryClient.invalidateQueries({ queryKey: recordKeys.lists(${P}_PATH) });`,
    `        toast.success(t('delete.done'));`,
    '        options?.onDeleted?.(target);',
    '      }}',
    '    />',
    '  );',
    '  return { ask, dialog };',
    '}',
  );
}

/** A field's initial form values, from `record` (an edit) or empty (a create): [input, expression]. */
function initial(f) {
  const r = `record?.${f.name}`;
  switch (f.type) {
    case 'bool':
      return [[f.name, `${r} ?? false`]];
    case 'int':
      return [[f.name, `${r} == null ? '' : String(${r})`]];
    case 'money':
      return [
        [`${f.name}Amount`, `${r}?.amount ?? ''`],
        [`${f.name}Currency`, `${r}?.currency ?? '${DEFAULT_CURRENCY}'`],
      ];
    case 'json':
      return [[f.name, `${r} ? JSON.stringify(${r}, null, 2) : ''`]];
    case 'enum':
      // A required one starts at its first value: a new form needs no pick.
      return [
        [f.name, `(${r} ?? '${f.optional ? '' : f.values[0]}') as string`],
      ];
    default:
      return [[f.name, `${r} ?? ''`]];
  }
}

/** The zod check of one input (a string the user typed, a boolean for a checkbox). */
function check(f, key) {
  const required = f.optional ? '' : ".min(1, t('form.required'))";
  const pattern = (re, message) =>
    `.refine((v) => v === '' || ${re}.test(v), t('${message}'))`;
  if (f.type === 'bool') return 'z.boolean()';
  if (f.type === 'money' && key.endsWith('Currency')) {
    return 'z.string().trim()' + pattern('CURRENCY', 'form.invalidCurrency');
  }
  switch (f.type) {
    case 'int':
      return (
        'z.string().trim()' + required + pattern('WHOLE', 'form.invalidWhole')
      );
    case 'decimal':
    case 'money':
      return (
        'z.string().trim()' +
        required +
        pattern('DECIMAL', 'form.invalidDecimal')
      );
    case 'date':
      return (
        'z.string().trim()' + required + pattern('DATE', 'form.invalidDate')
      );
    case 'datetime':
      return (
        'z.string().trim()' +
        required +
        ".refine((v) => v === '' || !Number.isNaN(Date.parse(v)), t('form.invalidDateTime'))"
      );
    case 'json':
      return (
        'z.string().trim()' +
        required +
        ".refine((v) => v === '' || isJsonObject(v), t('form.invalidJson'))"
      );
    case 'string':
    case 'enum':
      return 'z.string().trim()' + required;
    default: // text, ref
      return 'z.string()' + required;
  }
}

/** The subject a reference field points at (`customers` → `Customer`), as its `ref` names it. */
const refSubject = (t, f) =>
  f.ref === t.plural ? t.Singular : names(f.ref).Singular;

/** The statement that puts a field's form value(s) in the request body. */
function assign(f, S) {
  const v = `value.${f.name}`;
  const to = `body.${f.name}`;
  const blank = (expr) => (f.optional ? `${v} === '' ? null : ${expr}` : expr);
  switch (f.type) {
    case 'bool':
      return `${to} = ${v};`;
    case 'int':
      return `${to} = ${blank(`Number(${v})`)};`;
    case 'money': {
      const amount = `${v}Amount.trim()`;
      const object = `{ amount: ${amount}, currency: ${v}Currency.trim() }`;
      return `${to} = ${f.optional ? `${amount} === '' ? null : ${object}` : object};`;
    }
    case 'datetime':
      return `${to} = ${blank(`new Date(${v}.trim()).toISOString()`)};`;
    case 'json':
      return `${to} = ${blank(`JSON.parse(${v}) as Record<string, unknown>`)};`;
    case 'enum':
      return `${to} = ${blank(`${v} as ${S}Changes['${f.name}']`)};`;
    case 'text':
      return `${to} = ${blank(v)};`;
    default: // string, decimal, date, ref
      return `${to} = ${blank(`${v}.trim()`)};`;
  }
}

/** The control(s) of a field in the form. */
function control(t, f, first) {
  const name = f.name;
  const wrap = (key, element) =>
    `<form.AppField name="${key}">{(field) => ${element}}</form.AppField>`;
  const text = (key, labelKey, props = '') =>
    wrap(key, `<field.TextField label={t('fields.${labelKey}')}${props} />`);
  if (f.markdown) {
    return wrap(name, `<field.MarkdownField label={t('fields.${name}')} />`);
  }
  switch (f.type) {
    case 'date':
      // Typed as 2026-01-31 or picked on its calendar.
      return wrap(
        name,
        `<field.DateField label={t('fields.${name}')}${first ? ' autoFocus' : ''} />`,
      );
    case 'ref':
      // A picker of the target's records by title (GET /v1/lists/{subject}/options).
      return wrap(
        name,
        `<field.RecordField label={t('fields.${name}')} subject="${refSubject(t, f)}" />`,
      );
    case 'text':
    case 'json':
      return wrap(
        name,
        `<field.TextAreaField label={t('fields.${name}')} rows={${f.type === 'json' ? 6 : 4}} />`,
      );
    case 'enum':
      return wrap(
        name,
        `<field.SelectField label={t('fields.${name}')} options={[${f.values.map(quote).join(', ')}].map((value) => ({ value, label: t(${tpl(`enums.${name}.@{value}`)}) }))} />`,
      );
    case 'bool':
      return lines(
        `<form.AppField name="${name}">`,
        '{(field) => (',
        '<Field orientation="horizontal">',
        `<Checkbox id="${t.singular}-${name}" checked={field.state.value} onCheckedChange={(checked) => field.handleChange(checked === true)} />`,
        `<FieldLabel htmlFor="${t.singular}-${name}">{t('fields.${name}')}</FieldLabel>`,
        '</Field>',
        ')}',
        '</form.AppField>',
      );
    case 'money':
      return lines(
        text(`${name}Amount`, name, first ? ' autoFocus' : ''),
        text(`${name}Currency`, `${name}Currency`),
      );
    default: {
      const placeholder =
        f.type === 'datetime' ? ' placeholder="2026-01-31T09:00:00Z"' : '';
      // A `!numbered` field: left empty, its naming series fills it.
      const hint = f.numbered
        ? ` description={t('form.${name}Hint')}`
        : '';
      return text(
        name,
        name,
        placeholder + hint + (first ? ' autoFocus' : ''),
      );
    }
  }
}

/** The numbering picker of a create form (the `sequences` add-on): shown only when there is a choice. */
function seriesPicker(t) {
  return lines(
    '        {series.length > 1 && (',
    '          <Field>',
    `            <FieldLabel htmlFor="${t.singular}-numbering">{t('form.numbering')}</FieldLabel>`,
    '            <Select',
    '              items={series.map((s) => ({ value: s.id, label: ' +
      tpl('@{s.label ?? s.pattern} (@{s.example})') +
      ' }))}',
    '              value={seriesId}',
    '              onValueChange={(next) => next && setPickedSeries(next)}',
    '            >',
    `              <SelectTrigger id="${t.singular}-numbering" className="w-full">`,
    '                <SelectValue />',
    '              </SelectTrigger>',
    '              <SelectContent>',
    '                {series.map((s) => (',
    '                  <SelectItem key={s.id} value={s.id}>',
    '                    {s.label ?? s.pattern} ({s.example})',
    '                  </SelectItem>',
    '                ))}',
    '              </SelectContent>',
    '            </Select>',
    `            <FieldDescription>{t('form.numberingHint')}</FieldDescription>`,
    '          </Field>',
    '        )}',
  );
}

export function form({ t, fields, addons }) {
  const S = t.Singular;
  const P = t.PLURAL;
  const has = (...types) => fields.some((f) => types.includes(f.type));
  const custom = addons.includes('custom-fields');
  const numbered = addons.includes('sequences');
  const title = titleField(fields);
  const duplicates = addons.includes('merge') && title;
  const inputs = fields.flatMap((f) =>
    initial(f).map((entry) => [f, ...entry]),
  );
  // The first input that takes typing gets the focus.
  const first = fields.findIndex((f) => !['bool', 'enum'].includes(f.type));
  const moneyAliases = fields
    .filter((f) => f.type === 'money')
    .flatMap((f) => [
      `${f.name}: '${f.name}Amount',`,
      `'${f.name}.amount': '${f.name}Amount',`,
      `'${f.name}.currency': '${f.name}Currency',`,
    ]);
  const fieldParts = [
    (has('bool') || numbered) && 'Field',
    numbered && 'FieldDescription',
    'FieldGroup',
    (has('bool') || numbered) && 'FieldLabel',
  ].filter(Boolean);
  // What the form keeps outside its own values: the unsaved-changes guard asks about it too.
  const outside = [
    custom && 'Object.keys(edits).length > 0',
    numbered && 'pickedSeries !== undefined',
  ].filter(Boolean);
  const applyErrors =
    moneyAliases.length > 0
      ? [
          '        // A money field is two inputs: its errors name `<field>.amount` and `<field>.currency`.',
          '        const own = applyFieldErrors(form, caught, {',
          ...moneyAliases,
          '        });',
        ]
      : '        const own = applyFieldErrors(form, caught);';
  return lines(
    custom && `import { isApiError } from '@nestjs-monorepo/api-client';`,
    has('bool') &&
      `import { Checkbox } from '@nestjs-monorepo/ui/components/checkbox';`,
    `import { Button } from '@nestjs-monorepo/ui/components/button';`,
    `import { ${fieldParts.join(', ')} } from '@nestjs-monorepo/ui/components/field';`,
    numbered &&
      `import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@nestjs-monorepo/ui/components/select';`,
    custom
      ? `import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';`
      : `import { useMutation, useQueryClient } from '@tanstack/react-query';`,
    `import { Link, useNavigate } from '@tanstack/react-router';`,
    custom
      ? `import { useMemo, useState } from 'react';`
      : `import { useState } from 'react';`,
    `import { useTranslation } from 'react-i18next';`,
    `import { toast } from 'sonner';`,
    custom &&
      `import { CustomFieldInputs } from '@/components/records/custom-field-inputs';`,
    duplicates &&
      `import { DuplicatesWarning } from '@/features/merge/duplicates-warning';`,
    custom &&
      `import { customFieldsQuery, type CustomField } from '@/lib/custom-fields';`,
    custom &&
      `import { customBody, draftErrors, initialDrafts, serverErrors, type CustomDrafts } from '@/lib/custom-values';`,
    `import { applyFieldErrors, errorMessage } from '@/lib/errors';`,
    `import { FormAlert, useAppForm } from '@/lib/form';`,
    custom && `import { focusFirstInvalid } from '@/lib/form-focus';`,
    numbered && `import { useSubjectNamingSeries } from '@/features/naming-series/series';`,
    `import { isPreconditionFailed, useInvalidateRecords } from '@/lib/records';`,
    `import { useUnsavedChangesGuard } from '@/lib/unsaved-changes';`,
    `import { z } from '@/lib/zod';`,
    `import { ${P}_PATH, create${S}, update${S}, type ${S}, type ${S}Changes, type ${S}Create } from './api';`,
    '',
    custom && ['const NO_FIELDS: CustomField[] = [];', ''],
    has('int') && 'const WHOLE = /^-?\\d+$/;',
    has('decimal', 'money') && 'const DECIMAL = /^-?\\d+(\\.\\d+)?$/;',
    has('date') && 'const DATE = /^\\d{4}-\\d{2}-\\d{2}$/;',
    has('money') && 'const CURRENCY = /^[A-Z]{3}$/;',
    has('json') && [
      '',
      '/** A JSON object, as the API takes one. */',
      'function isJsonObject(text: string) {',
      '  try {',
      '    const parsed: unknown = JSON.parse(text);',
      "    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);",
      '  } catch {',
      '    return false;',
      '  }',
      '}',
    ],
    '',
    "/** What each input holds: text (a checkbox's value is a boolean), from the record or empty. */",
    `function initialValues(record?: ${S}) {`,
    '  return {',
    ...inputs.map(([, key, expr]) => `    ${key}: ${expr},`),
    '  };',
    '}',
    '',
    '/**',
    `  * Create (no record) or edit (a record and the etag it was read with): one`,
    `  * form of the fields in ${t.singular}.record.ts. An edit sends only what changed.`,
    '  * A field added to the record is added here by hand (`pnpm feature:sync` leaves',
    '  * the web files alone).',
    '  */',
    `export function ${S}Form(props: { record?: ${S}; etag?: string }) {`,
    '  const { record, etag } = props;',
    `  const { t } = useTranslation('${t.plural}');`,
    '  const navigate = useNavigate();',
    '  const queryClient = useQueryClient();',
    `  const invalidate = useInvalidateRecords(${P}_PATH);`,
    '  const [error, setError] = useState<string>();',
    custom && [
      "  const { t: tRecords } = useTranslation('records');",
      "  // `custom` left out of a record (field-level permissions) is not edited.",
      '  const showCustom = !record || record.custom !== undefined;',
      '  const definitions = useQuery({',
      `    ...customFieldsQuery('${S}'),`,
      '    enabled: showCustom,',
      '    meta: { errorToast: false },',
      '  });',
      '  const customFields = showCustom ? (definitions.data ?? NO_FIELDS) : NO_FIELDS;',
      '  const baseline = useMemo(() => initialDrafts(customFields, record?.custom), [customFields, record?.custom]);',
      '  const [edits, setEdits] = useState<CustomDrafts>({});',
      '  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});',
      '  const drafts = useMemo(() => ({ ...baseline, ...edits }), [baseline, edits]);',
    ],
    numbered && [
      "  // A new record takes the subject's default series unless another is",
      '  // picked; the picker shows only when there is a choice.',
      `  const namingSeries = useSubjectNamingSeries('${S}');`,
      '  const series = record ? [] : (namingSeries.data ?? []);',
      '  const [pickedSeries, setPickedSeries] = useState<string>();',
      '  const seriesId = pickedSeries ?? (series.find((s) => s.isDefault) ?? series[0])?.id;',
    ],
    '',
    '  const save = useMutation({',
    `    mutationFn: (body: ${S}Changes) =>`,
    '      record',
    `        ? update${S}(record.id, body, etag)`,
    `        : create${S}(body as ${S}Create),`,
    '    // The form shows the errors; the global handler stays quiet.',
    '    meta: { errorToast: false },',
    '  });',
    '',
    '  const form = useAppForm({',
    '    defaultValues: initialValues(record),',
    '    validators: {',
    '      onSubmit: z.object({',
    ...fields.flatMap((f) =>
      keysOf(f).map((key) => `        ${key}: ${check(f, key)},`),
    ),
    '      }),',
    '    },',
    '    onSubmit: async ({ value }) => {',
    '      setError(undefined);',
    custom && [
      '      // The custom values are checked by their definitions, as the API checks them.',
      '      const found = draftErrors(customFields, drafts, tRecords);',
      '      setCustomErrors(found);',
      '      if (Object.keys(found).length > 0) {',
      '        focusFirstInvalid(form);',
      '        return;',
      '      }',
    ],
    '      const before = initialValues(record);',
    // On create, what differs from the empty form (and every required field); on an edit, what changed.
    '      const changed = (...keys: (keyof typeof value)[]) =>',
    '        keys.some((key) => value[key] !== before[key]);',
    numbered
      ? `      const body: ${S}Changes & Pick<${S}Create, 'namingSeriesId'> = {};`
      : `      const body: ${S}Changes = {};`,
    ...fields.map(
      (f) =>
        `      if (${f.optional ? '' : '!record || '}changed(${keysOf(f).map(quote).join(', ')})) { ${assign(f, S)} }`,
    ),
    custom && [
      '      // On create, what differs from the defaults; on an edit, only what changed.',
      '      const custom = customBody(customFields, drafts, { stored: record?.custom, baseline });',
      '      if (Object.keys(custom).length > 0) body.custom = custom;',
    ],
    numbered && [
      '      // Only a new record, and only when the user had a choice.',
      '      if (series.length > 1 && seriesId) body.namingSeriesId = seriesId;',
    ],
    '      if (record && Object.keys(body).length === 0) {',
    '        // Nothing changed: no request, no new version.',
    `        await navigate({ to: '/${t.plural}/$id', params: { id: record.id }, ignoreBlocker: true });`,
    '        return;',
    '      }',
    '      try {',
    '        const saved = await save.mutateAsync(body);',
    '        await invalidate();',
    `        toast.success(record ? t('form.saved') : t('form.created'));`,
    "        // Saved: the record's page, past the unsaved-changes guard.",
    `        await navigate({ to: '/${t.plural}/$id', params: { id: saved.id }, ignoreBlocker: true });`,
    '      } catch (caught) {',
    '        if (isPreconditionFailed(caught)) {',
    '          // The record changed since it was read: reload it, then change it again.',
    `          setError(t('form.conflict'));`,
    '          await queryClient.invalidateQueries();',
    '          return;',
    '        }',
    custom
      ? [
          '        // The API names a custom value as `custom.<key>`: its input shows the message.',
          '        const customFound = serverErrors(isApiError(caught) ? caught.errors : []);',
          '        setCustomErrors(customFound);',
          applyErrors,
          '        if (!own && Object.keys(customFound).length === 0) setError(errorMessage(caught));',
        ]
      : [applyErrors, '        if (!own) setError(errorMessage(caught));'],
    '      }',
    '    },',
    '  });',
    outside.length > 0
      ? [
          '  // The custom values and the series are kept outside the form.',
          `  useUnsavedChangesGuard(form, ${outside.join(' || ')});`,
        ]
      : '  useUnsavedChangesGuard(form);',
    '',
    '  return (',
    '    <form',
    '      className="flex flex-col gap-6"',
    '      noValidate',
    '      onSubmit={(event) => {',
    '        event.preventDefault();',
    '        void form.handleSubmit();',
    '      }}',
    '    >',
    '      <FormAlert message={error} />',
    '      <FieldGroup>',
    ...fields.map((f, i) => [
      control(t, f, i === first),
      f === title &&
        duplicates && [
          '        {/* Likely duplicates of what is typed: a hint, never a block. */}',
          `        <form.Subscribe selector={(state) => state.values.${f.name}}>`,
          `          {(${f.name}) => <DuplicatesWarning subject="${S}" listPath={${P}_PATH} values={{ ${f.name} }} excludeId={record?.id} />}`,
          '        </form.Subscribe>',
        ],
    ]),
    numbered && seriesPicker(t),
    custom && [
      '        {showCustom && (',
      '          <CustomFieldInputs',
      '            fields={customFields}',
      '            value={drafts}',
      '            errors={customErrors}',
      '            onChange={(key, draft) => {',
      '              setEdits((current) => ({ ...current, [key]: draft }));',
      '              setCustomErrors(({ [key]: _gone, ...rest }) => rest);',
      '            }}',
      '          />',
      '        )}',
    ],
    '      </FieldGroup>',
    '      <div className="flex gap-2">',
    '        <form.AppForm>',
    `          <form.SubmitButton>{record ? t('form.save') : t('form.create')}</form.SubmitButton>`,
    '        </form.AppForm>',
    '        <Button',
    '          variant="outline"',
    '          nativeButton={false}',
    '          render={',
    '            record ? (',
    `              <Link to="/${t.plural}/$id" params={{ id: record.id }} />`,
    '            ) : (',
    `              <Link to="/${t.plural}" />`,
    '            )',
    '          }',
    '        >',
    `          {t('form.cancel')}`,
    '        </Button>',
    '      </div>',
    '    </form>',
    '  );',
    '}',
  );
}

/** A field's column on the list: none for long text, JSON and references (the detail page shows them). */
function column(t, f) {
  const n = f.name;
  const header = `...header('${n}')`;
  switch (f.type) {
    case 'text':
    case 'json':
    case 'ref':
      return false;
    case 'money':
      // The list filters a money field by its currency (GET /v1/lists/<Subject>).
      return `{ id: '${n}Currency', accessorFn: (row) => row.${n} ? ${tpl(`@{row.${n}.amount} @{row.${n}.currency}`)} : '', ...header('${n}', '${n}') },`;
    case 'bool':
      return `{ id: '${n}', accessorFn: (row) => row.${n} == null ? '' : t(row.${n} ? 'values.yes' : 'values.no'), ...header('${n}') },`;
    case 'enum':
      return lines(
        `{ id: '${n}', accessorKey: '${n}', ...header('${n}'),`,
        `cell: ({ row }) => row.original.${n} ? <Badge variant="outline">{t(${tpl(`enums.${n}.@{row.original.${n}}`)})}</Badge> : null },`,
      );
    case 'datetime':
      return `{ id: '${n}', accessorFn: (row) => date(row.${n}), ...header('${n}') },`;
    default:
      return `{ id: '${n}', accessorKey: '${n}', ...header('${n}') },`;
  }
}

export function listPage({ t, fields, softDelete, addons }) {
  const has = (...types) => fields.some((f) => types.includes(f.type));
  const S = t.Singular;
  const P = t.PLURAL;
  const item = t.singularCamel;
  const title = titleField(fields);
  const withBadge = fields.some((f) => f.type === 'enum');
  const columns = fields.filter(
    (f) => f.type !== 'text' && f.type !== 'json' && f.type !== 'ref',
  );
  return lines(
    `import type { paths } from '@nestjs-monorepo/api-client';`,
    withBadge &&
      `import { Badge } from '@nestjs-monorepo/ui/components/badge';`,
    `import { Button } from '@nestjs-monorepo/ui/components/button';`,
    `import { DropdownMenuItem, DropdownMenuSeparator } from '@nestjs-monorepo/ui/components/dropdown-menu';`,
    `import { Link, createFileRoute } from '@tanstack/react-router';`,
    `import type { HeaderContext } from '@tanstack/react-table';`,
    `import { PlusIcon } from 'lucide-react';`,
    `import { useCallback, useMemo } from 'react';`,
    `import { useTranslation } from 'react-i18next';`,
    `import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';`,
    `import { ListPage } from '@/components/list-page';`,
    `import { BulkRunChip, useBulkRun } from '@/components/records/bulk-run-filter';`,
    softDelete &&
      `import { RecycleBinToggle, useRecycleBin } from '@/components/records/recycle-bin';`,
    softDelete
      ? `import { ${P}_BIN_QUERY, ${P}_LIST_QUERY, ${P}_PATH } from '@/features/${t.plural}/api';`
      : `import { ${P}_LIST_QUERY, ${P}_PATH } from '@/features/${t.plural}/api';`,
    `import { use${S}Delete } from '@/features/${t.plural}/use-${t.singular}-delete';`,
    `import { Can } from '@/lib/features';`,
    `import { useDateTimeFormat } from '@/lib/date-time';`,
    `import type { DataTableFeatures } from '@/lib/data-table-features';`,
    `import type { ListColumn } from '@/lib/list-query';`,
    `import { useWritesPaused } from '@/lib/mode';`,
    `import { useRecordCan } from '@/lib/records';`,
    '',
    `export const Route = createFileRoute('/_app/${t.plural}/')({ component: ${t.Plural} });`,
    '',
    `type ${S} = paths['/v1/${t.plural}']['get']['responses'][200]['content']['application/json']['items'][number];`,
    '',
    `function ${t.Plural}() {`,
    `  const { t } = useTranslation('${t.plural}');`,
    '  const date = useDateTimeFormat();',
    softDelete && '  const bin = useRecycleBin();',
    "  // `?bulkRun=<id>`: what a bulk run changed (its notification's link).",
    '  const run = useBulkRun();',
    `  const canOf = useRecordCan('${S}');`,
    '  // While the API refuses writes (read-only, maintenance) the actions that write stay in sight but off.',
    '  const paused = useWritesPaused();',
    softDelete
      ? `  const { ask, restore, dialog } = use${S}Delete();`
      : `  const { ask, dialog } = use${S}Delete();`,
    '',
    '  // Cells and headers only: whether a column filters or sorts, and how, comes',
    `  // from GET /v1/lists/${S} (see withListMeta).`,
    `  const columns = useMemo<ListColumn<${S}>[]>(() => {`,
    has('money')
      ? '    const header = (key: string, selects?: string) => {'
      : '    const header = (key: string) => {',
    `      const label = t(${tpl('fields.@{key}')});`,
    '      return {',
    // A money column filters by its currency (its id) and reads the field.
    has('money') ? '        meta: { label, selects },' : '        meta: { label },',
    `        header: ({ column }: HeaderContext<DataTableFeatures, ${S}, unknown>) => (`,
    '          <DataTableColumnHeader column={column} label={label} />',
    '        ),',
    '      };',
    '    };',
    '    return [',
    numberColumn(addons, fields) &&
      `      { id: 'number', accessorKey: 'number', ...header('number') },`,
    ...columns.map((f) =>
      f === title
        ? lines(
            `      {`,
            `        id: '${f.name}',`,
            `        accessorKey: '${f.name}',`,
            `        ...header('${f.name}'),`,
            "        // The keyboard's way in; a click anywhere on the row does the same.",
            '        cell: ({ row }) => (',
            `          <Link to="/${t.plural}/$id" params={{ id: row.original.id }} className="font-medium underline-offset-4 hover:underline">`,
            `            {row.original.${f.name}}`,
            '          </Link>',
            '        ),',
            '      },',
          )
        : '      ' + column(t, f),
    ),
    `      { id: 'createdAt', accessorFn: (row) => date(row.createdAt, 'date'), ...header('createdAt') },`,
    '    ];',
    '  }, [t, date]);',
    '',
    '  const rowActions = useCallback(',
    `    (${item}: ${S}) => {`,
    `      const can = canOf(${item});`,
    '      return (',
    '        <>',
    `          <DropdownMenuItem render={<Link to="/${t.plural}/$id" params={{ id: ${item}.id }} />}>`,
    `            {t('actions.view')}`,
    '          </DropdownMenuItem>',
    softDelete && [
      '          {bin.deleted ? (',
      '            can.restore && (',
      `              <DropdownMenuItem disabled={paused} onClick={() => void restore(${item}).catch(() => {})}>`,
      `                {t('actions.restore')}`,
      '              </DropdownMenuItem>',
      '            )',
      '          ) : (',
      '            <>',
    ],
    `          {can.update && (`,
    `            <DropdownMenuItem disabled={paused} render={<Link to="/${t.plural}/$id/edit" params={{ id: ${item}.id }} />}>`,
    `              {t('actions.edit')}`,
    '            </DropdownMenuItem>',
    '          )}',
    '          {can.delete && (',
    '            <>',
    '              <DropdownMenuSeparator />',
    `              <DropdownMenuItem variant="destructive" disabled={paused} onClick={() => ask(${item})}>`,
    `                {t('actions.delete')}`,
    '              </DropdownMenuItem>',
    '            </>',
    '          )}',
    softDelete && ['            </>', '          )}'],
    '        </>',
    '      );',
    '    },',
    `    [t, ${softDelete ? 'bin.deleted, ' : ''}canOf, ask, ${softDelete ? 'restore, ' : ''}paused],`,
    '  );',
    '',
    '  return (',
    '    <>',
    '      <ListPage',
    `        subject="${S}"`,
    `        path={${P}_PATH}`,
    softDelete
      ? `        title={bin.deleted ? t('bin.showing') : t('title')}`
      : `        title={t('title')}`,
    '        columns={columns}',
    softDelete
      ? `        query={{ ...(bin.deleted ? ${P}_BIN_QUERY : ${P}_LIST_QUERY), ...run.query }}`
      : `        query={{ ...${P}_LIST_QUERY, ...run.query }}`,
    softDelete &&
      "        // The bin's records are gone from the detail route (404); the bin is not exported.",
    softDelete
      ? `        rowHref={bin.deleted ? undefined : (${item}) => ${tpl(`/${t.plural}/@{${item}.id}`)}}`
      : `        rowHref={(${item}) => ${tpl(`/${t.plural}/@{${item}.id}`)}}`,
    '        rowActions={rowActions}',
    softDelete && '        exportable={!bin.deleted}',
    '        toolbarActions={',
    '          <>',
    '            {run.id && <BulkRunChip onClear={run.clear} />}',
    softDelete && [
      `            <Can permission="${S}.restore">`,
      `              <RecycleBinToggle label={t('bin.label')} pressed={bin.deleted} onToggle={bin.toggle} />`,
      '            </Can>',
    ],
    `            <Can permission="${S}.create">`,
    `              <Button nativeButton={false} disabled={paused} render={<Link to="/${t.plural}/new" />}>`,
    '                <PlusIcon />',
    `                {t('new.action')}`,
    '              </Button>',
    '            </Can>',
    '          </>',
    '        }',
    '      />',
    '      {dialog}',
    '    </>',
    '  );',
    '}',
  );
}

export function newPage({ t }) {
  const S = t.Singular;
  return lines(
    `import { createFileRoute, redirect } from '@tanstack/react-router';`,
    `import { useTranslation } from 'react-i18next';`,
    `import { Page, PageHeader } from '@/components/page-header';`,
    `import { ${S}Form } from '@/features/${t.plural}/${t.singular}-form';`,
    '',
    `export const Route = createFileRoute('/_app/${t.plural}/new')({`,
    '  // The API refuses it anyway; a user without the permission has no use for the form.',
    '  beforeLoad: ({ context }) => {',
    `    if (!context.me.can['${S}.create']) {`,
    `      throw redirect({ to: '/${t.plural}' });`,
    '    }',
    '  },',
    `  component: New${S},`,
    '});',
    '',
    `function New${S}() {`,
    `  const { t } = useTranslation('${t.plural}');`,
    '  return (',
    '    <Page width="narrow">',
    `      <PageHeader title={t('new.title')} />`,
    `      <${S}Form />`,
    '    </Page>',
    '  );',
    '}',
  );
}

export function editPage({ t }) {
  const S = t.Singular;
  const item = t.singularCamel;
  return lines(
    `import { Alert, AlertDescription, AlertTitle } from '@nestjs-monorepo/ui/components/alert';`,
    `import { Button } from '@nestjs-monorepo/ui/components/button';`,
    `import { useQuery } from '@tanstack/react-query';`,
    `import { Link, createFileRoute, redirect } from '@tanstack/react-router';`,
    `import { LockIcon } from 'lucide-react';`,
    `import { useTranslation } from 'react-i18next';`,
    `import { Page, PageHeader } from '@/components/page-header';`,
    `import { RecordState } from '@/components/records/record-state';`,
    `import { ${item}Query } from '@/features/${t.plural}/api';`,
    `import { ${S}Form } from '@/features/${t.plural}/${t.singular}-form';`,
    `import { useRecordCan } from '@/lib/records';`,
    '',
    `export const Route = createFileRoute('/_app/${t.plural}/$id/edit')({`,
    '  beforeLoad: ({ context, params }) => {',
    `    if (!context.me.can['${S}.update']) {`,
    `      throw redirect({ to: '/${t.plural}/$id', params });`,
    '    }',
    '  },',
    `  component: Edit${S},`,
    '});',
    '',
    `function Edit${S}() {`,
    '  const { id } = Route.useParams();',
    `  const { t } = useTranslation('${t.plural}');`,
    `  const canOf = useRecordCan('${S}');`,
    '  // The form is made from one read and sent back with its ETag: a refetch in the',
    "  // background (focus, reconnect) must not replace it under the user's typing.",
    '  const query = useQuery({',
    `    ...${item}Query(id),`,
    '    refetchOnWindowFocus: false,',
    '    refetchOnReconnect: false,',
    '  });',
    '  return (',
    '    <Page width="narrow">',
    `      <PageHeader title={t('edit.title')} />`,
    '      <RecordState',
    '        query={query}',
    `        notFound={{ title: t('notFound.title'), description: t('notFound.description') }}`,
    `        error={{ title: t('error.title'), generic: t('error.generic'), retry: t('error.retry') }}`,
    '      >',
    `        {({ ${item}, etag }) =>`,
    "          // The permission let the user in (beforeLoad); the record's own `can` says whether its conditions allow it now.",
    `          canOf(${item}).update ? (`,
    '            // Keyed by what was last saved: a change by someone else (the reload after a 412) remounts the form.',
    `            <${S}Form key={${item}.updatedAt} record={${item}} etag={etag} />`,
    '          ) : (',
    '            <Alert role="alert">',
    '              <LockIcon />',
    `              <AlertTitle>{t('edit.locked.title')}</AlertTitle>`,
    '              <AlertDescription>',
    `                <p>{t('edit.locked.description')}</p>`,
    `                <Button variant="outline" size="sm" className="mt-2" nativeButton={false} render={<Link to="/${t.plural}/$id" params={{ id: ${item}.id }} />}>`,
    `                  {t('edit.locked.back')}`,
    '                </Button>',
    '              </AlertDescription>',
    '            </Alert>',
    '          )',
    '        }',
    '      </RecordState>',
    '    </Page>',
    '  );',
    '}',
  );
}

/** The detail page's line for a field: a value, null (a dash) or undefined (left out for this user). */
function detail(t, f) {
  const r = `${t.singularCamel}.${f.name}`;
  const shown = (element) => `${r} == null ? ${r} : ${element}`;
  switch (f.type) {
    case 'text':
      return shown(
        f.markdown
          ? `<MarkdownText>{${r}}</MarkdownText>`
          : `<p className="whitespace-pre-wrap">{${r}}</p>`,
      );
    case 'money':
      return shown(tpl(`@{${r}.amount} @{${r}.currency}`));
    case 'bool':
      return shown(`t(${r} ? 'values.yes' : 'values.no')`);
    case 'datetime':
      return `date(${r})`;
    case 'json':
      return shown(
        `<pre className="overflow-x-auto text-xs">{JSON.stringify(${r}, null, 2)}</pre>`,
      );
    case 'enum':
      return shown(
        `<Badge variant="outline">{t(${tpl(`enums.${f.name}.@{${r}}`)})}</Badge>`,
      );
    case 'ref':
      // Its title, as a picker shows it; the id until known.
      return shown(`<RecordName subject="${refSubject(t, f)}" value={${r}} />`);
    default:
      return r;
  }
}

export function detailPage({ t, fields, softDelete, addons }) {
  const S = t.Singular;
  const P = t.PLURAL;
  const item = t.singularCamel;
  const title = titleField(fields);
  const enums = fields.some((f) => f.type === 'enum');
  const custom = addons.includes('custom-fields');
  const name = title ? `${item}.${title.name}` : `${item}.id`;
  return lines(
    enums && `import { Badge } from '@nestjs-monorepo/ui/components/badge';`,
    `import { Button } from '@nestjs-monorepo/ui/components/button';`,
    `import {`,
    '  DropdownMenu,',
    '  DropdownMenuContent,',
    '  DropdownMenuItem,',
    '  DropdownMenuSeparator,',
    '  DropdownMenuTrigger,',
    `} from '@nestjs-monorepo/ui/components/dropdown-menu';`,
    `import { useQuery } from '@tanstack/react-query';`,
    `import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';`,
    `import { ArrowLeftIcon, EllipsisIcon } from 'lucide-react';`,
    `import { useTranslation } from 'react-i18next';`,
    fields.some((f) => f.markdown) &&
      `import { MarkdownText } from '@/components/markdown/lazy';`,
    fields.some((f) => f.type === 'ref') &&
      `import { RecordName } from '@/components/person-name';`,
    `import { Page, PageHeader } from '@/components/page-header';`,
    custom &&
      `import { CustomFieldValues } from '@/components/records/custom-field-values';`,
    `import { DetailItem, DetailList } from '@/components/records/detail-list';`,
    `import { RecordPanels } from '@/components/records/panels/record-panels';`,
    `import { RecordState } from '@/components/records/record-state';`,
    `import { ${item}Query, type ${S} } from '@/features/${t.plural}/api';`,
    `import { use${S}Delete } from '@/features/${t.plural}/use-${t.singular}-delete';`,
    addons.includes('recents') &&
      `import { useRecordRecent } from '@/features/recents/api';`,
    `import { useDateTimeFormat } from '@/lib/date-time';`,
    `import { useWritesPaused } from '@/lib/mode';`,
    `import { useRecordCan } from '@/lib/records';`,
    '',
    `export const Route = createFileRoute('/_app/${t.plural}/$id/')({`,
    `  component: ${S}Detail,`,
    '});',
    '',
    `function ${S}Detail() {`,
    '  const { id } = Route.useParams();',
    `  const { t } = useTranslation('${t.plural}');`,
    `  const query = useQuery(${item}Query(id));`,
    '  return (',
    '    <Page>',
    '      <Link',
    `        to="/${t.plural}"`,
    '        className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"',
    '      >',
    '        <ArrowLeftIcon className="size-4 rtl:rotate-180" />',
    `        {t('detail.back')}`,
    '      </Link>',
    '      <RecordState',
    '        query={query}',
    `        notFound={{ title: t('notFound.title'), description: t('notFound.description') }}`,
    `        error={{ title: t('error.title'), generic: t('error.generic'), retry: t('error.retry') }}`,
    '      >',
    `        {({ ${item} }) => <${S}View ${item}={${item}} />}`,
    '      </RecordState>',
    '    </Page>',
    '  );',
    '}',
    '',
    `function ${S}View({ ${item} }: { ${item}: ${S} }) {`,
    `  const { t } = useTranslation('${t.plural}');`,
    '  const date = useDateTimeFormat();',
    '  const navigate = useNavigate();',
    "  // The record's own `can`: its conditions too, not only the permission.",
    `  const { update: canUpdate, delete: canDelete } = useRecordCan('${S}')(${item});`,
    '  // Off while the API refuses writes (read-only, maintenance); the banner says why.',
    '  const paused = useWritesPaused();',
    `  const { ask, dialog } = use${S}Delete({`,
    `    onDeleted: () => void navigate({ to: '/${t.plural}' }),`,
    softDelete &&
      `    onRestored: (restored) => void navigate({ to: '/${t.plural}/$id', params: { id: restored.id } }),`,
    '  });',
    addons.includes('recents') && [
      "  // The visit goes to the user's recent records.",
      `  useRecordRecent({ subject: '${S}', recordId: ${item}.id, label: ${name} });`,
    ],
    '',
    '  return (',
    '    <>',
    '      <PageHeader',
    `        title={${name}}`,
    numberColumn(addons, fields) && `        description={${item}.number}`,
    '        actions={',
    '          (canUpdate || canDelete) && (',
    '            <DropdownMenu>',
    '              <DropdownMenuTrigger',
    `                render={<Button variant="outline" size="icon" aria-label={t('actions.open')} />}`,
    '              >',
    '                <EllipsisIcon />',
    '              </DropdownMenuTrigger>',
    '              <DropdownMenuContent align="end">',
    '                {canUpdate && (',
    `                  <DropdownMenuItem disabled={paused} render={<Link to="/${t.plural}/$id/edit" params={{ id: ${item}.id }} />}>`,
    `                    {t('actions.edit')}`,
    '                  </DropdownMenuItem>',
    '                )}',
    '                {canUpdate && canDelete && <DropdownMenuSeparator />}',
    '                {canDelete && (',
    `                  <DropdownMenuItem variant="destructive" disabled={paused} onClick={() => ask(${item})}>`,
    `                    {t('actions.delete')}`,
    '                  </DropdownMenuItem>',
    '                )}',
    '              </DropdownMenuContent>',
    '            </DropdownMenu>',
    '          )',
    '        }',
    '      />',
    '      <DetailList>',
    ...fields.map(
      (f) =>
        `        <DetailItem label={t('fields.${f.name}')} value={${detail(t, f)}} />`,
    ),
    custom && `        <CustomFieldValues subject="${S}" values={${item}.custom} />`,
    `        <DetailItem label={t('fields.updatedAt')} value={date(${item}.updatedAt)} />`,
    '      </DetailList>',
    `      <RecordPanels subject="${S}" path="/v1/${t.plural}/{id}" id={${item}.id} canUpdate={canUpdate}${addons.includes('tags') ? `  tags={${item}.tags}` : ''} />`,
    '      {dialog}',
    '    </>',
    '  );',
    '}',
  );
}

/** A field's value as the API answers it (a record in the test's list) and as the user types it into the form. */
function sample(f) {
  switch (f.type) {
    case 'string':
      return {
        api: 'Sample ' + f.name,
        typed: 'Sample ' + f.name,
        body: 'Sample ' + f.name,
      };
    case 'text':
      return { api: 'Some text.', typed: 'Some text.', body: 'Some text.' };
    case 'int':
      return { api: 3, typed: '3', body: 3 };
    case 'decimal':
      return { api: '12.50', typed: '12.50', body: '12.50' };
    case 'money':
      return {
        api: { amount: '19.99', currency: 'EUR' },
        typed: '19.99',
        body: { amount: '19.99', currency: 'EUR' },
      };
    case 'bool':
      return { api: true, typed: null, body: false };
    case 'date':
      return { api: '2026-01-31', typed: '2026-01-31', body: '2026-01-31' };
    case 'datetime':
      return {
        api: '2026-01-31T09:00:00.000Z',
        typed: '2026-01-31T09:00:00Z',
        body: '2026-01-31T09:00:00.000Z',
      };
    case 'enum':
      return { api: f.values[0], typed: null, body: f.values[0] };
    case 'json':
      return { api: { size: 'm' }, typed: '{"size":"m"}', body: { size: 'm' } };
    default: // ref
      return { api: null, typed: null, body: null };
  }
}

export function test({ t, fields, softDelete, addons }) {
  const S = t.Singular;
  const route = `/v1/${t.plural}`;
  const title = titleField(fields);
  const record = {
    id: '__ID__',
    ...(numberColumn(addons, fields) && {
      number: `${S.slice(0, 3).toUpperCase()}-2026-00001`,
    }),
    ...Object.fromEntries(fields.map((f) => [f.name, sample(f).api])),
    ...(addons.includes('custom-fields') && { custom: {} }),
    createdAt: '2026-10-17T09:00:00.000Z',
    updatedAt: '2026-10-17T09:00:00.000Z',
    deletedAt: null,
    can: { update: true, delete: true, restore: false },
  };
  // What a create sends: each required field typed in, the rest as the form leaves them.
  const required = fields.filter((f) => !f.optional);
  const typed = required.filter((f) => sample(f).typed !== null);
  const expected = Object.fromEntries(
    required.map((f) => [f.name, sample(f).body]),
  );
  const fill = typed.map((f) =>
    lines(
      `    await user.click(await screen.findByLabelText('${label(f.name)}'));`,
      `    await user.paste(${JSON.stringify(sample(f).typed)});`,
    ),
  );
  const on = (name) => addons.includes(name);
  const createAndCheck = (expected) => [
    `    await user.click(await screen.findByRole('button', { name: 'Create ${t.noun}' }));`,
    '    await waitFor(() => expect(calls.created).toHaveLength(1));',
    `    expect(calls.created[0]).toMatchObject(${expected});`,
  ];
  const permissions = [
    'read',
    'create',
    'update',
    'delete',
    ...(softDelete ? ['restore'] : []),
  ];
  return lines(
    `import { screen, waitFor } from '@testing-library/react';`,
    `import userEvent from '@testing-library/user-event';`,
    `import { http, HttpResponse } from 'msw/http';`,
    `import { describe, expect, it } from 'vitest';`,
    on('custom-fields') &&
      `import { field } from '@/features/custom-fields/test/custom-fields-api';`,
    on('sequences') &&
      `import { series } from '@/features/naming-series/test/naming-series-api';`,
    `import { panelsDescription } from '@/test/panels-api';`,
    `import { renderApp } from '@/test/render-app';`,
    `import { server } from '@/test/server';`,
    `import { useSignedIn } from '@/test/signed-in';`,
    `import { findToast } from '@/test/toast';`,
    '',
    `const ALL = [${permissions.map((p) => quote(`${S}.${p}`)).join(', ')}];`,
    `const ID = '0199a3f2-0000-7000-8000-000000000601';`,
    '',
    '// The generated test: the routes of the generated API (the e2e test beside it) as msw serves them, in memory.',
    "// Extend it with the feature's own rules.",
    '',
    '/** One record, as GET ' + route + ' answers. */',
    'const sample = () => (' +
      JSON.stringify(record, null, 2).replace('"__ID__"', 'ID') +
      ');',
    '',
    '/** Signs in with these permissions and serves the one record; returns what the pages sent. */',
    'function useApi(can: string[]) {',
    '  useSignedIn(can);',
    '  const calls = {',
    '    created: [] as unknown[],',
    '    patched: [] as { body: unknown; ifMatch: string | null }[],',
    '    listed: [] as URL[],',
    '  };',
    '  server.use(',
    `    http.get('/v1/lists/:subject', () =>`,
    '      HttpResponse.json({',
    `        subject: '${S}',`,
    '        fields: [],',
    // What a list may select: what a visible column asks for (`fields=`).
    `        select: ${JSON.stringify(['id', ...(numberColumn(addons, fields) ? ['number'] : []), ...fields.map((f) => f.name), 'createdAt']).replaceAll('"', "'")},`,
    '        search: false,',
    `        recycleBin: ${softDelete},`,
    `        defaultSort: '-createdAt',`,
    '        limits: { defaultLimit: 50, maxLimit: 100 },',
    '        // No panels: the generated feature takes none until its capabilities say so.',
    '        ...panelsDescription(',
    // Off: each record panel whose module is there (a removed one has no key).
    `          { ${[
      ...['comments', 'attachments', 'tags', 'revisions']
        .filter((name) => name in ADDONS)
        .map((name) => `${name}: false`),
      ...(on('merge') ? ['merge: true'] : []),
    ].join(', ')} },`,
    '          null,',
    '        ),',
    '      }),',
    '    ),',
    on('custom-fields') &&
      `    http.get('/v1/custom-fields', () => HttpResponse.json({ items: [] })),`,
    on('sequences') &&
      `    http.get('/v1/naming-series', () => HttpResponse.json({ items: [], nextCursor: null })),`,
    // A reference's picker and its name: the records of its subject.
    fields.some((f) => f.type === 'ref') &&
      `    http.get('/v1/lists/:subject/options', () => HttpResponse.json({ items: [] })),`,
    on('merge') && [
      `    http.post('${route}/duplicates', () => HttpResponse.json({ items: [] })),`,
      `    http.get('${route}/:id/duplicates', () => HttpResponse.json({ items: [] })),`,
    ],
    `    http.get('${route}', ({ request }) => {`,
    '      calls.listed.push(new URL(request.url));',
    '      return HttpResponse.json({ items: [sample()], page: 1, pageCount: 1 });',
    '    }),',
    `    http.post('${route}', async ({ request }) => {`,
    '      const body = (await request.json()) as Record<string, unknown>;',
    '      calls.created.push(body);',
    '      return HttpResponse.json({ ...sample(), ...body }, { status: 201 });',
    '    }),',
    `    http.get('${route}/:id', () =>`,
    `      HttpResponse.json(sample(), { headers: { etag: '"v1"' } }),`,
    '    ),',
    `    http.patch('${route}/:id', async ({ request }) => {`,
    '      const body = (await request.json()) as Record<string, unknown>;',
    `      calls.patched.push({ body, ifMatch: request.headers.get('if-match') });`,
    '      return HttpResponse.json({ ...sample(), ...body });',
    '    }),',
    '  );',
    '  return calls;',
    '}',
    '',
    `describe('the ${t.nouns} list', () => {`,
    `  it('shows the records, with a way to add one', async () => {`,
    '    useApi(ALL);',
    `    await renderApp('/${t.plural}');`,
    `    expect(await screen.findByRole('heading', { name: '${cap(t.nouns)}' })).toBeVisible();`,
    title &&
      `    expect(await screen.findByRole('link', { name: '${sample(title).api}' })).toBeVisible();`,
    `    expect(await screen.findByRole('button', { name: 'New ${t.noun}' })).toBeVisible();`,
    '  });',
    '',
    ...fields
      .filter((f) => f.type === 'money')
      .map((f) =>
        lines(
          `  it('shows ${label(f.name).toLowerCase()} in its column: the list asks for ${f.name}', async () => {`,
          '    const calls = useApi(ALL);',
          `    await renderApp('/${t.plural}');`,
          `    expect(await screen.findByText('19.99 EUR')).toBeVisible();`,
          `    expect(calls.listed.at(-1)?.searchParams.get('fields')?.split(',')).toContain('${f.name}');`,
          '  });',
          '',
        ),
      ),
    '  it("offers no way to add one without the permission", async () => {',
    `    useApi(['${S}.read']);`,
    `    await renderApp('/${t.plural}');`,
    `    await screen.findByRole('heading', { name: '${cap(t.nouns)}' });`,
    `    expect(screen.queryByRole('button', { name: 'New ${t.noun}' })).not.toBeInTheDocument();`,
    '  });',
    '',
    "  it('shows only what a bulk run changed, from its notification', async () => {",
    '    const calls = useApi(ALL);',
    `    await renderApp('/${t.plural}?bulkRun=run-1');`,
    "    const chip = await screen.findByRole('button', { name: /Changed by a bulk edit/ });",
    "    await waitFor(() => expect(calls.listed.at(-1)?.searchParams.get('bulkRun')).toBe('run-1'));",
    '    await userEvent.setup().click(chip);',
    "    await waitFor(() => expect(calls.listed.at(-1)?.searchParams.get('bulkRun')).toBeNull());",
    '  });',
    '});',
    '',
    `describe('the ${t.noun} form', () => {`,
    `  it('creates ${t.aNoun} from the required fields', async () => {`,
    '    const calls = useApi(ALL);',
    `    await renderApp('/${t.plural}/new');`,
    '    const user = userEvent.setup();',
    ...fill,
    `    await user.click(await screen.findByRole('button', { name: 'Create ${t.noun}' }));`,
    '    await waitFor(() => expect(calls.created).toHaveLength(1));',
    `    expect(calls.created[0]).toMatchObject(${JSON.stringify(expected)});`,
    `    await findToast('${cap(t.noun)} created');`,
    '  });',
    '});',
    title && [
      '',
      `describe('editing ${t.aNoun}', () => {`,
      `  it('sends only what changed, with the ETag it was read with', async () => {`,
      '    const calls = useApi(ALL);',
      `    await renderApp(${tpl(`/${t.plural}/@{ID}/edit`)});`,
      '    const user = userEvent.setup();',
      `    const field = await screen.findByLabelText('${label(title.name)}');`,
      '    await user.clear(field);',
      '    await user.click(field);',
      '    await user.paste("Renamed");',
      `    await user.click(screen.getByRole('button', { name: 'Save changes' }));`,
      '    await waitFor(() => expect(calls.patched).toHaveLength(1));',
      `    expect(calls.patched[0]).toEqual({ body: { ${title.name}: 'Renamed' }, ifMatch: '"v1"' });`,
      `    await findToast('${cap(t.noun)} saved');`,
      '  });',
      '});',
    ],
    ['custom-fields', 'merge', 'recents', 'sequences'].some(on) && [
      '',
      `describe('the add-ons of ${t.nouns}', () => {`,
      on('custom-fields') && [
        "  it('custom fields: the form sends their values', async () => {",
        '    const calls = useApi(ALL);',
        '    server.use(',
        `      http.get('/v1/custom-fields', () => HttpResponse.json({ items: [field({ subject: '${S}', key: 'reference', label: 'Reference', type: 'text', options: null })] })),`,
        '    );',
        `    await renderApp('/${t.plural}/new');`,
        '    const user = userEvent.setup();',
        ...fill,
        "    await user.click(await screen.findByLabelText('Reference'));",
        "    await user.paste('R-1');",
        ...createAndCheck("{ custom: { reference: 'R-1' } }"),
        '  });',
      ],
      on('merge') &&
        title && [
          '',
          "  it('merge: the form warns of a likely duplicate of what is typed', async () => {",
          '    useApi(ALL);',
          '    server.use(',
          `      http.post('${route}/duplicates', () => HttpResponse.json({ items: [{ id: '0199a3f2-0000-7000-8000-000000000602', matched: [['${title.name}']], record: { ${title.name}: ${JSON.stringify(sample(title).api)} } }] })),`,
          '    );',
          `    await renderApp('/${t.plural}/new');`,
          '    const user = userEvent.setup();',
          `    await user.click(await screen.findByLabelText('${label(title.name)}'));`,
          `    await user.paste(${JSON.stringify(sample(title).typed)});`,
          "    expect(await screen.findByText('This may already exist:')).toBeVisible();",
          '  });',
        ],
      on('recents') && [
        '',
        "  it('recents: the detail page records the visit', async () => {",
        '    useApi(ALL);',
        '    const visits: unknown[] = [];',
        '    server.use(',
        "      http.post('/v1/recents', async ({ request }) => {",
        '        visits.push(await request.json());',
        '        return HttpResponse.json({});',
        '      }),',
        '    );',
        `    await renderApp(${tpl(`/${t.plural}/@{ID}`)});`,
        `    await waitFor(() => expect(visits).toContainEqual({ subject: '${S}', recordId: ID, label: ${title ? JSON.stringify(sample(title).api) : 'ID'} }));`,
        '  });',
      ],
      on('sequences') && [
        '',
        "  it('sequences: a new record takes the default of two series', async () => {",
        '    const calls = useApi(ALL);',
        '    server.use(',
        `      http.get('/v1/naming-series', () => HttpResponse.json({ items: [series({ subject: '${S}' }), series({ id: 's2', subject: '${S}', label: 'Other', isDefault: false })], nextCursor: null })),`,
        '    );',
        `    await renderApp('/${t.plural}/new');`,
        '    const user = userEvent.setup();',
        "    expect(await screen.findByRole('combobox', { name: 'Numbering' })).toBeVisible();",
        ...fill,
        ...createAndCheck("{ namingSeriesId: 's1' }"),
        '  });',
      ],
      '});',
    ],
  );
}
