import { Button } from '@nestjs-monorepo/ui/components/button';
import { XIcon } from 'lucide-react';
import { parseAsString, useQueryState } from 'nuqs';
import { useTranslation } from 'react-i18next';

/**
 * Whether a list shows only what a bulk run changed: `?bulkRun=<id>` in the
 * URL (nuqs), the link of the run's notification, which becomes ListPage's
 * `query` (`GET /v1/<x>?bulkRun=<id>`). Clearing it starts again at the
 * first page.
 */
export function useBulkRun() {
  const [id, setId] = useQueryState('bulkRun', parseAsString);
  const [, setPage] = useQueryState('page', parseAsString);
  const clear = () => {
    void setPage(null);
    void setId(null);
  };
  return { id, clear, query: id ? { bulkRun: id } : undefined };
}

/** Shown while a list is narrowed to a bulk run: says so, and clears it. */
export function BulkRunChip(props: { onClear: () => void }) {
  const { t } = useTranslation('records');
  return (
    <Button type="button" variant="secondary" onClick={props.onClear}>
      {t('bulkRun.showing')}
      <XIcon aria-label={t('bulkRun.clear')} />
    </Button>
  );
}
