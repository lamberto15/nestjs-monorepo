import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchCombobox } from '@/components/search-combobox';
import { recordSearchQuery, useRecordNames } from '@/lib/record-names';

/** A record as a picker names it: its title field, its number, else its id. */
export function recordName(
  item: Record<string, unknown>,
  title: string | null,
) {
  return (
    (title ? (item[title] as string | null | undefined) : null) ??
    (item.number as string | null | undefined) ??
    (item.id as string)
  );
}

/**
 * A form's control for a reference (a `ref` field): picks a record of the
 * target subject by searching its titles as one types (`GET
 * /v1/lists/{subject}/options?q=`, lib/record-names.ts), Dice UI's combobox
 * with the search done by the API (`manualFiltering`), as PersonPicker. It
 * offers only the records the user may read, so the API takes what is
 * picked; the value is the record's id, its title shown once known.
 */
export function RecordPicker(props: {
  id: string;
  label: string;
  /** The target's subject (`TestItem`), as its reference field names it. */
  subject: string;
  value: string;
  onChange: (id: string) => void;
  /** What the input shows for the current value before any search: else its title, once known. */
  initialLabel?: string;
  placeholder?: string;
  invalid?: boolean;
  /** The ids of the hint and the error the caller shows beside it (`useDescribedBy`). */
  describedBy?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('records');
  const [term, setTerm] = useState('');
  const found = useQuery({
    ...recordSearchQuery(props.subject, term),
    placeholderData: keepPreviousData,
  });
  const names = useRecordNames(props.subject, [props.value]);
  const known = props.initialLabel ?? names.get(props.value);
  const items = (found.data ?? []).map((item) => ({
    value: item.id,
    name: item.title ?? item.id,
  }));
  const empty = found.isError
    ? t('picker.failed')
    : found.isFetching
      ? t('picker.searching')
      : t('picker.none');

  return (
    <SearchCombobox
      // Its input starts with the current record's title: again once that is known.
      key={known === undefined ? 'unnamed' : 'named'}
      id={props.id}
      label={props.label}
      value={props.value}
      onChange={props.onChange}
      onSearch={setTerm}
      items={items}
      empty={empty}
      initialLabel={known}
      placeholder={props.placeholder ?? t('picker.placeholder')}
      invalid={props.invalid}
      describedBy={props.describedBy}
      disabled={props.disabled}
    />
  );
}
