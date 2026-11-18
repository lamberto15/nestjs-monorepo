import { unwrap } from '@nestjs-monorepo/api-client';
import { useQuery } from '@tanstack/react-query';
import { PersonName } from '@/components/person-name';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo/ui/components/dialog';
import { DropdownMenuItem } from '@nestjs-monorepo/ui/components/dropdown-menu';
import type { HeaderContext } from '@tanstack/react-table';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { actionLabel } from './action-label';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { ListPage } from '@/components/list-page';
import type { AuditEntry } from '@/features/audit/api';
import { api } from '@/lib/api';
import type { DataTableFeatures } from '@/lib/data-table-features';
import { useDateTimeFormat } from '@/lib/date-time';
import type { ListColumn } from '@/lib/list-query';

/** Details as text: a string as is, anything else as indented JSON. Never HTML. */
export function detailsText(details: unknown): string {
  if (details === null || details === undefined) {
    return '';
  }
  return typeof details === 'string'
    ? details
    : (JSON.stringify(details, null, 2) ?? '');
}

/** A bulk run's line: its start, which names the run (`targetId`). */
const isRun = (entry: AuditEntry) =>
  entry.action === 'bulk.started' && !!entry.targetId;

/** The entries of a run its dialog lists at most; more: filter the list by `runId`. */
const RUN_ENTRIES = 100;

/** Entries outside every run, and each run's start: one line per run. */
const ONE_LINE_PER_RUN = { 'runId.isNull': 'true' };

/**
 * The audit log (`GET /v1/access/audit`) on the generic list page: filters
 * (the actor by name or address included), sorts and paging come from
 * GET /v1/lists/Audit; the details of an entry open from its row's menu.
 * A bulk run is one line (its start); its dialog lists the run's entries,
 * one per record.
 */
export function AuditPage() {
  const { t } = useTranslation('audit');
  const format = useDateTimeFormat();
  const [shown, setShown] = useState<AuditEntry>();

  // Cells and headers only: filters and sorts come from the list's metadata.
  const columns = useMemo<ListColumn<AuditEntry>[]>(() => {
    const header = (key: string) => {
      const label = t(`columns.${key}`);
      return {
        meta: { label },
        header: ({
          column,
        }: HeaderContext<DataTableFeatures, AuditEntry, unknown>) => (
          <DataTableColumnHeader column={column} label={label} />
        ),
      };
    };
    const mono = (value: string | null) => (
      <span className="font-mono text-xs">{value}</span>
    );
    return [
      {
        id: 'at',
        accessorFn: (entry) => format(entry.at),
        ...header('at'),
      },
      {
        id: 'actorLabel',
        accessorFn: (entry) => entry.actorLabel,
        ...header('actor'),
        // No stored label: the person by key (one batched lookup for the
        // page). `actor` comes only when its own column is shown, and
        // `system:*` stays as it is.
        cell: ({ row }) =>
          row.original.actorLabel ??
          (row.original.actor ? (
            <PersonName value={row.original.actor} />
          ) : null),
      },
      {
        id: 'action',
        accessorKey: 'action',
        ...header('action'),
        cell: ({ row }) => (
          <span title={row.original.action}>
            {actionLabel(t, row.original.action)}
          </span>
        ),
      },
      {
        id: 'targetType',
        accessorKey: 'targetType',
        ...header('targetType'),
      },
      {
        id: 'targetId',
        accessorKey: 'targetId',
        ...header('targetId'),
        cell: ({ row }) => mono(row.original.targetId),
      },
      {
        id: 'ip',
        accessorKey: 'ip',
        ...header('ip'),
        cell: ({ row }) => mono(row.original.ip),
      },
      {
        // Asked for so the row's dialog has them; the cell is a glimpse.
        id: 'details',
        accessorFn: (entry) => detailsText(entry.details),
        ...header('details'),
        cell: ({ row }) => (
          <span className="block max-w-64 truncate font-mono text-xs">
            {row.original.details ? JSON.stringify(row.original.details) : ''}
          </span>
        ),
      },
    ];
  }, [t, format]);

  const rowActions = useCallback(
    (entry: AuditEntry) => (
      <DropdownMenuItem onClick={() => setShown(entry)}>
        {isRun(entry) ? t('run.open') : t('details.open')}
      </DropdownMenuItem>
    ),
    [t],
  );

  return (
    <>
      <ListPage
        subject="Audit"
        path="/v1/access/audit"
        title={t('title')}
        columns={columns}
        rowActions={rowActions}
        query={ONE_LINE_PER_RUN}
      />
      <Dialog
        open={!!shown}
        onOpenChange={(open) => !open && setShown(undefined)}
      >
        <DialogContent className="sm:max-w-xl">
          {shown && <EntryDetails entry={shown} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function EntryDetails(props: { entry: AuditEntry }) {
  const { t } = useTranslation('audit');
  const format = useDateTimeFormat();
  const { entry } = props;
  const text = detailsText(entry.details);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-base">
          {actionLabel(t, entry.action)}
        </DialogTitle>
        <DialogDescription>
          {format(entry.at)}
          <code className="ms-2 text-xs">{entry.action}</code>
        </DialogDescription>
      </DialogHeader>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
        <dt className="text-muted-foreground">{t('details.actor')}</dt>
        <dd>
          {entry.actorLabel ??
            (entry.actor ? <PersonName value={entry.actor} /> : null)}
        </dd>
        {/* Only when the actor column is shown: the page asks for what it shows. */}
        {entry.actor && (
          <>
            <dt className="text-muted-foreground">{t('details.actorId')}</dt>
            <dd className="font-mono">{entry.actor}</dd>
          </>
        )}
        {entry.ip && (
          <>
            <dt className="text-muted-foreground">{t('columns.ip')}</dt>
            <dd className="font-mono">{entry.ip}</dd>
          </>
        )}
      </dl>
      {/* Text in a <pre>: React escapes it, nothing is parsed as HTML. */}
      <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
        {text || t('details.none')}
      </pre>
      {isRun(entry) && <RunEntries runId={entry.targetId!} />}
    </>
  );
}

/** What a bulk run did, entry by entry (`GET /v1/access/audit?runId=`). */
function RunEntries(props: { runId: string }) {
  const { t } = useTranslation('audit');
  const query = useQuery({
    queryKey: ['audit', 'run', props.runId],
    queryFn: () =>
      unwrap(
        api.GET('/v1/access/audit', {
          params: {
            query: { runId: props.runId, limit: RUN_ENTRIES, sort: 'at' },
          },
        }),
      ),
  });
  const items = query.data?.items ?? [];
  return (
    <section aria-label={t('run.entries')} className="space-y-1 text-xs">
      <h3 className="font-medium">{t('run.entries')}</h3>
      {query.isPending ? (
        <p className="text-muted-foreground">{t('run.loading')}</p>
      ) : (
        <ul className="max-h-64 overflow-auto">
          {items.map((item) => (
            <li key={item.id} className="flex gap-2">
              <span>{actionLabel(t, item.action)}</span>
              <span className="font-mono text-muted-foreground">
                {item.targetId}
              </span>
            </li>
          ))}
        </ul>
      )}
      {query.data?.nextCursor || query.data?.nextPage ? (
        <p className="text-muted-foreground">
          {t('run.more', { count: RUN_ENTRIES })}
        </p>
      ) : null}
    </section>
  );
}
