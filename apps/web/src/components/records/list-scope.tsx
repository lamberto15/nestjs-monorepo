import { Button } from '@nestjs-monorepo/ui/components/button';
import { XIcon } from 'lucide-react';
import { parseAsString, useQueryStates } from 'nuqs';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RecordName } from '@/components/person-name';

/**
 * A list narrowed to the records of one parent: `?<field>=<id>` in the URL
 * (nuqs) for one of the list's references, the link "Open all" of a
 * parent's child table (RelatedPanel). It becomes ListPage's `query`, a
 * flat filter of the list route (`GET /v1/invoice-lines?invoiceId=<id>`),
 * so search, sort, filters and the export work within it. `refs` names the
 * references the list takes this way and their subjects
 * (`{ invoiceId: 'Invoice' }`). Clearing it starts again at the first page.
 */
export function useListScope(refs: Readonly<Record<string, string>>) {
  const parsers = useMemo(
    () =>
      Object.fromEntries(
        [...Object.keys(refs), 'page'].map((key) => [key, parseAsString]),
      ),
    [refs],
  );
  const [values, setValues] = useQueryStates(parsers);
  const scoped = Object.keys(refs).flatMap((field) => {
    const id = values[field];
    return id ? [{ field, id, subject: refs[field] as string }] : [];
  });
  const clear = () =>
    void setValues(
      Object.fromEntries(Object.keys(parsers).map((key) => [key, null])),
    );
  return {
    scoped,
    clear,
    query: scoped.length
      ? Object.fromEntries(scoped.map((s) => [s.field, s.id]))
      : undefined,
  };
}

/** Shown while a list is narrowed to a parent: names it, and clears it. */
export function ListScopeChip(props: {
  scoped: { field: string; id: string; subject: string }[];
  onClear: () => void;
}) {
  const { t } = useTranslation('records');
  if (!props.scoped.length) return null;
  return (
    <Button type="button" variant="secondary" onClick={props.onClear}>
      {t('scope.showing')}{' '}
      {props.scoped.map((s, i) => (
        <span key={s.field}>
          {i > 0 && ', '}
          <RecordName subject={s.subject} value={s.id} />
        </span>
      ))}
      <XIcon aria-label={t('scope.clear')} />
    </Button>
  );
}
