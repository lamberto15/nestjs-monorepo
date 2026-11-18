import type { CustomFieldType } from '../custom-fields/custom-field.types.js';
import { valueSchema } from '../custom-fields/custom-field.values.js';
import {
  fieldsOf,
  FORM_LIMITS,
  type FormDefinition,
  type FormField,
  type GroupField,
  type SchemaIssue,
} from './form-definition.js';
import { walkForm } from './form-rules.js';

/**
 * How a submission's answers are checked: on the server, against the
 * published version it names, never against what the client says the form
 * is. Pure functions (README.md, "Submissions"). A text or a date is
 * checked as a custom field's value is (`valueSchema`, modules/custom-fields):
 * the same limits, the same RE2 patterns, the same email and http(s) checks.
 *
 * - Only the version's keys: an unknown key is refused (`answers.<key>`),
 *   not dropped, so a client out of step learns it.
 * - Empty (absent, null, a blank string, an empty list) takes the field's
 *   default, else is refused when required, else left out.
 * - Normalized: text trimmed, numbers given as numeric strings read as
 *   numbers; the stored answer holds the version's keys alone.
 * - Conditions (format 2) decide in form order which fields show and which
 *   are required (form-rules.ts). A hidden field's answer is stripped,
 *   deterministically: neither checked, nor stored, nor filled with its
 *   default, whatever the client sent; it is never required.
 */

/** The answers as JSON, in bytes, at most (under the request's own 100 KiB). */
export const MAX_ANSWERS_BYTES = 64 * 1024;

/** The most choices of a sourced multiSelect: each is a provider's check. */
export const SOURCED_CHOICES = 50;

/** The custom field type whose values a form's text field takes. */
const TEXT_TYPES: Partial<Record<FormField['type'], CustomFieldType>> = {
  text: 'text',
  textarea: 'longText',
  email: 'email',
  url: 'url',
};

/** The first problem of a value against a custom field's rules, or null. */
const customIssue = (
  type: CustomFieldType,
  validation: Pick<
    NonNullable<FormField['validation']>,
    'minLength' | 'maxLength' | 'pattern'
  >,
  value: string,
) => {
  const parsed = valueSchema({ type, options: null, validation }).safeParse(
    value,
  );
  return parsed.success ? null : parsed.error.issues[0]!.message;
};

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

type Checked =
  { ok: true; value: unknown } | { ok: false; message: string; index?: number };

const refuse = (message: string, index?: number): Checked => ({
  ok: false,
  message,
  index,
});

const numberOf = (value: unknown) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return Number.NaN;
};

/** One non-empty value checked against its field, normalized. */
export function checkValue(field: FormField, value: unknown): Checked {
  const rules = field.validation ?? {};
  const values = (field.options ?? []).map((option) => option.value);
  // A sourced field's values are the provider's: their shape here, whether
  // the person may pick them in FormOptionSourcesService.answerIssues.
  const isChoice = (item: unknown) =>
    typeof item === 'string' &&
    (field.optionsSource
      ? item.length > 0 && item.length <= 200
      : values.includes(item));
  switch (field.type) {
    case 'checkbox':
      if (typeof value !== 'boolean') return refuse('Must be true or false.');
      if (field.required && !value) return refuse('Must be checked.');
      return { ok: true, value };
    case 'integer':
    case 'decimal': {
      const number = numberOf(value);
      if (!Number.isFinite(number)) return refuse('Must be a number.');
      if (field.type === 'integer' && !Number.isSafeInteger(number)) {
        return refuse('Must be a whole number.');
      }
      if (rules.decimals !== undefined) {
        const [, fraction = ''] = String(number).split('.');
        if (fraction.length > rules.decimals || String(number).includes('e')) {
          return refuse(`At most ${rules.decimals} decimals.`);
        }
      }
      if (rules.min !== undefined && number < rules.min) {
        return refuse(`At least ${rules.min}.`);
      }
      if (rules.max !== undefined && number > rules.max) {
        return refuse(`At most ${rules.max}.`);
      }
      return { ok: true, value: number };
    }
    case 'date': {
      if (
        typeof value !== 'string' ||
        customIssue('date', {}, value) !== null
      ) {
        return refuse('Must be a date (YYYY-MM-DD).');
      }
      if (rules.minDate !== undefined && value < rules.minDate) {
        return refuse(`On ${rules.minDate} or later.`);
      }
      if (rules.maxDate !== undefined && value > rules.maxDate) {
        return refuse(`On ${rules.maxDate} or earlier.`);
      }
      return { ok: true, value };
    }
    case 'select':
    case 'radio':
      if (!isChoice(value)) return refuse('Must be one of the options.');
      return { ok: true, value };
    case 'multiSelect': {
      if (!Array.isArray(value)) return refuse('Must be a list of options.');
      const most = field.optionsSource ? SOURCED_CHOICES : values.length;
      if (value.length > most) return refuse('Too many choices.');
      for (const [index, item] of value.entries()) {
        if (!isChoice(item)) {
          return refuse('Must be one of the options.', index);
        }
        if (value.indexOf(item) !== index) {
          return refuse('Each choice may appear once.', index);
        }
      }
      if (rules.minItems !== undefined && value.length < rules.minItems) {
        return refuse(`At least ${rules.minItems} choices.`);
      }
      if (rules.maxItems !== undefined && value.length > rules.maxItems) {
        return refuse(`At most ${rules.maxItems} choices.`);
      }
      return { ok: true, value: [...value] };
    }
    default: {
      // text, textarea, email, url
      if (typeof value !== 'string') return refuse('Must be text.');
      const text = value.trim();
      const { minLength, maxLength, pattern } = rules;
      const problem = customIssue(
        TEXT_TYPES[field.type]!,
        { minLength, maxLength, pattern },
        text,
      );
      return problem === null ? { ok: true, value: text } : refuse(problem);
    }
  }
}

/** A default's problem, for the schema's own checks (`definitionIssues`). */
export const defaultIssue = (field: FormField, value: unknown) => {
  const checked = checkValue({ ...field, required: false }, value);
  return checked.ok ? null : checked.message;
};

/** One field's answer (normalized), or undefined with its issue at `path`. */
function answerOf(
  field: FormField | GroupField,
  value: unknown,
  required: boolean,
  path: string,
  issues: SchemaIssue[],
): unknown {
  if (isEmpty(value) && field.default === undefined) {
    if (required) issues.push({ path, message: 'This field is required.' });
    return undefined;
  }
  // A default is checked as an answer (a required checkbox's `false` is refused).
  const checked = checkValue(
    { ...field, required } as FormField,
    isEmpty(value) ? field.default : value,
  );
  if (checked.ok) return checked.value;
  issues.push({
    path: checked.index === undefined ? path : `${path}.${checked.index}`,
    message: checked.message,
  });
  return undefined;
}

/**
 * A repeatable group's answer: a list of items, each an object of its
 * fields' answers, checked at `answers.<group>.<index>.<key>`. None (an
 * empty list) is refused only when required; otherwise between `minItems`
 * and `maxItems`, never more than FORM_LIMITS.groupItems. An unknown key in
 * an item is refused.
 */
function groupAnswer(
  field: FormField,
  value: unknown,
  required: boolean,
  path: string,
  issues: SchemaIssue[],
): unknown {
  const rules = field.validation ?? {};
  const items = value ?? [];
  if (!Array.isArray(items)) {
    issues.push({ path, message: 'Must be a list of items.' });
    return undefined;
  }
  // Empty is no answer, as a multiSelect's: refused only when required.
  if (items.length === 0) {
    if (required) issues.push({ path, message: 'This field is required.' });
    return undefined;
  }
  const min = rules.minItems ?? 0;
  const max = Math.min(rules.maxItems ?? Infinity, FORM_LIMITS.groupItems);
  if (items.length < min) {
    issues.push({ path, message: `At least ${min} items.` });
    return undefined;
  }
  if (items.length > max) {
    issues.push({ path, message: `At most ${max} items.` });
    return undefined;
  }
  const fields = field.fields ?? [];
  const known = new Set(fields.map((sub) => sub.key));
  const before = issues.length;
  const answers = items.map((item: unknown, index) => {
    const at = `${path}.${index}`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      issues.push({ path: at, message: 'An object of answers by key.' });
      return {};
    }
    const given = item as Record<string, unknown>;
    for (const key of Object.keys(given)) {
      if (!known.has(key)) {
        issues.push({
          path: `${at}.${key.slice(0, 64)}`,
          message: 'Not a field of this group.',
        });
      }
    }
    const answer: Record<string, unknown> = {};
    for (const sub of fields) {
      const checked = answerOf(
        sub,
        Object.hasOwn(given, sub.key) ? given[sub.key] : undefined,
        sub.required === true,
        `${at}.${sub.key}`,
        issues,
      );
      if (checked !== undefined) answer[sub.key] = checked;
    }
    return answer;
  });
  return issues.length === before ? answers : undefined;
}

/**
 * The answers of a submission checked against a version's definition:
 * the normalized answers, or the issues at `answers.<key>` (and
 * `answers.<key>.<index>` in a list).
 */
export function checkAnswers(
  definition: FormDefinition,
  input: unknown,
):
  | { ok: true; answers: Record<string, unknown> }
  | { ok: false; issues: SchemaIssue[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      issues: [{ path: 'answers', message: 'An object of answers by key.' }],
    };
  }
  const given = input as Record<string, unknown>;
  const fields = fieldsOf(definition);
  const known = new Set(fields.map((field) => field.key));
  const issues: SchemaIssue[] = [];
  for (const key of Object.keys(given)) {
    if (!known.has(key)) {
      issues.push({
        path: `answers.${key.slice(0, 64)}`,
        message: 'Not a field of this version of the form.',
      });
    }
  }
  const { answers } = walkForm(definition.sections, (field, required) => {
    const value = Object.hasOwn(given, field.key)
      ? given[field.key]
      : undefined;
    return field.type === 'group'
      ? groupAnswer(field, value, required, `answers.${field.key}`, issues)
      : answerOf(field, value, required, `answers.${field.key}`, issues);
  });
  if (issues.length > 0) return { ok: false, issues };
  const bytes = Buffer.byteLength(JSON.stringify(answers));
  if (bytes > MAX_ANSWERS_BYTES) {
    return {
      ok: false,
      issues: [
        {
          path: 'answers',
          message: `The answers are ${bytes} bytes as JSON: at most ${MAX_ANSWERS_BYTES}.`,
        },
      ],
    };
  }
  return { ok: true, answers };
}
