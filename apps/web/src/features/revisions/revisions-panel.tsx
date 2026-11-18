import { Badge } from '@nestjs-monorepo/ui/components/badge';
import { Button } from '@nestjs-monorepo/ui/components/button';
import { Skeleton } from '@nestjs-monorepo/ui/components/skeleton';
import {
  Timeline,
  TimelineConnector,
  TimelineContent,
  TimelineDescription,
  TimelineDot,
  TimelineHeader,
  TimelineItem,
  TimelineTime,
  TimelineTitle,
} from '@nestjs-monorepo/ui/components/timeline';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ConflictAlert } from '@/components/records/conflict-alert';
import { RelativeTime } from '@/features/notifications/relative-time';
import { errorMessage } from '@/lib/errors';
import { useDateTimeFormat } from '@/lib/date-time';
import { isPreconditionFailed, recordKeys } from '@/lib/records';
import {
  revisionKeys,
  diffRevisions,
  listRevisions,
  restoreRevision,
  type Revision,
} from './api';

/** A changed value as text: strings as they are, the rest as JSON. */
export function showValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function DiffTable(props: {
  from: number;
  to: number;
  changes: Record<string, { from: unknown; to: unknown }>;
}) {
  const { t } = useTranslation('revisions');
  const fields = Object.entries(props.changes);
  return (
    <section
      aria-label={t('diffTitle', { a: props.from, b: props.to })}
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <h3 className="text-sm font-medium">
        {t('diffTitle', { a: props.from, b: props.to })}
      </h3>
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noDiff')}</p>
      ) : (
        <div className="grid grid-cols-[minmax(6rem,auto)_1fr_1fr] gap-x-4 gap-y-2 text-sm">
          <span />
          <span className="text-xs font-medium text-muted-foreground">
            {t('revision', { number: props.from })}
          </span>
          <span className="text-xs font-medium text-muted-foreground">
            {t('revision', { number: props.to })}
          </span>
          {fields.map(([field, change]) => (
            <div key={field} className="contents" data-field={field}>
              <span className="font-medium break-words">{field}</span>
              <span className="rounded bg-red-50 p-1.5 break-words whitespace-pre-wrap dark:bg-red-950/40">
                {showValue(change.from) || (
                  <span className="text-muted-foreground">—</span>
                )}
              </span>
              <span className="rounded bg-green-50 p-1.5 break-words whitespace-pre-wrap dark:bg-green-950/40">
                {showValue(change.to) || (
                  <span className="text-muted-foreground">—</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The record's history (newest first) as a timeline: who and when, what
 * changed. Tick two to see how they differ (`GET …/revisions/{a}/diff/{b}`),
 * restore one (who may change the record) after a confirmation. Restore sends
 * the record's ETag: if it changed since, the API answers 412 and the
 * conflict alert offers to reload.
 */
export function RevisionsPanel(props: {
  /** The record's list route (`/v1/<plural>`), as the record pages key it. */
  listPath: string;
  base: string;
  id: string;
  canRestore: boolean;
}) {
  const { t } = useTranslation('revisions');
  const date = useDateTimeFormat();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<number[]>([]);
  const [compare, setCompare] = useState<[number, number] | null>(null);
  const [asking, setAsking] = useState<Revision | null>(null);
  const [conflict, setConflict] = useState(false);

  const query = useQuery({
    queryKey: revisionKeys.list(props.base, props.id),
    queryFn: () => listRevisions(props.base, props.id),
  });
  const diff = useQuery({
    enabled: compare !== null,
    queryKey: revisionKeys.diff(
      props.base,
      props.id,
      compare?.[0] ?? 0,
      compare?.[1] ?? 0,
    ),
    queryFn: () =>
      diffRevisions(props.base, props.id, compare![0], compare![1]),
  });
  const restore = useMutation({
    meta: { errorToast: false },
    mutationFn: (number: number) => {
      const cached = queryClient.getQueryData<{ etag?: string }>(
        recordKeys.detail(props.listPath, props.id),
      );
      return restoreRevision(props.base, props.id, number, cached?.etag);
    },
  });

  const refreshRecord = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: recordKeys.details(props.listPath),
      }),
      queryClient.invalidateQueries({
        queryKey: recordKeys.lists(props.listPath),
      }),
      queryClient.invalidateQueries({
        queryKey: revisionKeys.list(props.base, props.id),
      }),
    ]);

  const who = (revision: Revision) => {
    if (revision.changedBy === 'unknown') return t('unknown');
    if (revision.changedBy === 'anonymized')
      return t('common:actors.anonymous');
    if (revision.changedBy.startsWith('client:'))
      return t('common:actors.system');
    return revision.changedByName ?? t('common:actors.someone');
  };

  const toggle = (number: number) => {
    setCompare(null);
    setPicked((current) =>
      current.includes(number)
        ? current.filter((n) => n !== number)
        : [...current.slice(-1), number],
    );
  };

  if (query.isPending) {
    return <Skeleton className="h-24 w-full" aria-busy />;
  }
  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error')}
      </p>
    );
  }
  const revisions = query.data;
  const latest = revisions[0]?.number;
  if (revisions.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {conflict && (
        <ConflictAlert
          title={t('conflictTitle')}
          description={t('conflictDescription')}
          reload={t('reload')}
          onReload={async () => {
            await refreshRecord();
            setConflict(false);
          }}
        />
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={picked.length !== 2}
          onClick={() => {
            const [a, b] = [...picked].sort((x, y) => x - y);
            setCompare([a!, b!]);
          }}
        >
          {t('compare')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('pickHint')}</span>
      </div>
      {compare && diff.data && (
        <DiffTable
          from={diff.data.from}
          to={diff.data.to}
          changes={diff.data.changes}
        />
      )}
      <Timeline orientation="vertical">
        {revisions.map((revision) => (
          <TimelineItem key={revision.id}>
            <TimelineDot />
            <TimelineConnector />
            <TimelineContent>
              <TimelineHeader>
                <TimelineTitle className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={picked.includes(revision.number)}
                      onChange={() => toggle(revision.number)}
                      aria-label={t('pick', {
                        number: revision.number,
                      })}
                    />
                    {t('revision', { number: revision.number })}
                  </label>
                  {revision.number === latest && (
                    <Badge variant="secondary">{t('current')}</Badge>
                  )}
                  {revision.restoredFrom !== null && (
                    <Badge variant="outline">
                      {t('restoredFrom', {
                        number: revision.restoredFrom,
                      })}
                    </Badge>
                  )}
                </TimelineTitle>
                <TimelineTime
                  dateTime={revision.changedAt}
                  title={date(revision.changedAt)}
                >
                  <RelativeTime value={revision.changedAt} />
                </TimelineTime>
              </TimelineHeader>
              <TimelineDescription>
                {t('by', { name: who(revision) })}
                {revision.changes &&
                  Object.keys(revision.changes).length > 0 && (
                    <span className="block text-xs">
                      {Object.keys(revision.changes).join(', ')}
                    </span>
                  )}
              </TimelineDescription>
              {props.canRestore && revision.number !== latest && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setAsking(revision)}
                >
                  {t('restore')}
                </Button>
              )}
            </TimelineContent>
          </TimelineItem>
        ))}
      </Timeline>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        title={t('restoreTitle', { number: asking?.number })}
        description={t('restoreDescription', {
          number: asking?.number,
        })}
        confirm={t('restore')}
        onConfirm={async () => {
          try {
            await restore.mutateAsync(asking!.number);
          } catch (error) {
            if (isPreconditionFailed(error)) {
              setConflict(true);
              return;
            }
            toast.error(errorMessage(error));
            throw error;
          }
          setPicked([]);
          setCompare(null);
          setConflict(false);
          await refreshRecord();
          toast.success(t('restored'));
        }}
      />
    </div>
  );
}
