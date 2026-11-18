/**
 * What a custom field is: its type, choices and limits. Shared with what
 * builds forms from the same definitions (dynamic forms, later).
 */
export const CUSTOM_FIELD_TYPES = [
  'text',
  'longText',
  'number',
  'boolean',
  'date',
  'select',
  'multiSelect',
  'email',
  'url',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** A choice of a `select` or `multiSelect` field: `value` is stored, `label` shown. */
export interface CustomFieldOption {
  value: string;
  label: string;
}

/**
 * Optional limits of a field, by type:
 * - number: `min` / `max` (the value);
 * - multiSelect: `min` / `max` (how many choices);
 * - text, longText, email, url: `minLength` / `maxLength`, `pattern` (RE2, the whole value).
 */
export interface CustomFieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/** What checking a value needs of a definition. */
export interface CustomFieldShape {
  type: CustomFieldType;
  options: CustomFieldOption[] | null;
  validation: CustomFieldValidation | null;
}

/** A field as validation and the list need it (a row of custom_field_definitions). */
export interface CustomFieldDefinition extends CustomFieldShape {
  id: string;
  subject: string;
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  defaultValue: unknown;
  position: number;
  filterable: boolean;
  sortable: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const hasOptions = (type: CustomFieldType) =>
  type === 'select' || type === 'multiSelect';
