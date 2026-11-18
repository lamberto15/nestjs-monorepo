import { isApiError } from '@nestjs-monorepo/api-client';
import { Alert, AlertDescription } from '@nestjs-monorepo/ui/components/alert';
import { Button, buttonVariants } from '@nestjs-monorepo/ui/components/button';
import { Field, FieldLabel } from '@nestjs-monorepo/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo/ui/components/select';
import { Skeleton } from '@nestjs-monorepo/ui/components/skeleton';
import { Spinner } from '@nestjs-monorepo/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlertIcon, DownloadIcon, FileTextIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RelativeTime } from '@/features/notifications/relative-time';
import { errorMessage } from '@/lib/errors';
import { useFeatures, useMe } from '@/lib/features';
import { useRealtime, useRealtimeEvent } from '@/lib/realtime';
import { toast } from 'sonner';
import {
  documentDownloadUrl,
  issueDocument,
  listDocuments,
  panelKeys,
  type RecordDocument,
} from './api';

/** A language by its own name ("Deutsch"), so a reader finds theirs. */
function languageName(code: string) {
  try {
    return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** One document of the record: running, failed (and why), or issued with its download. */
function DocumentRow(props: { document: RecordDocument }) {
  const { t } = useTranslation('documents');
  const me = useMe()?.user.id;
  const { document } = props;
  const name = t('name', { language: languageName(document.language) });
  const by =
    document.issuedBy === `user:${me}`
      ? t('byYou')
      : document.issuedBy === 'anonymized'
        ? t('byAnonymized')
        : (document.issuedByName ?? t('byOther'));
  const running =
    document.status === 'queued' || document.status === 'rendering';
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium">
          <FileTextIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{name}</span>
        </p>
        {running ? (
          <p role="status" className="text-xs text-muted-foreground">
            {document.status === 'rendering'
              ? t('status.rendering')
              : t('status.queued')}
          </p>
        ) : document.status === 'failed' ? (
          <p className="flex items-center gap-1 text-xs text-destructive">
            <CircleAlertIcon className="size-3" aria-hidden />
            {document.error ?? t('status.failed')}
          </p>
        ) : (
          <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            <span>
              {t('issuedAt')}{' '}
              <RelativeTime value={document.finishedAt ?? document.createdAt} />
            </span>
            <span>{by}</span>
          </p>
        )}
      </div>
      {running ? (
        <Spinner aria-label={t('status.progressLabel')} />
      ) : (
        document.status === 'completed' && (
          /* A plain link: the API redirects to a signed link (5 minutes) and
             names the file (Content-Disposition: attachment), so the browser
             saves the PDF; nothing of it is shown inside the app. It takes
             the right to read every field the PDF shows: else a 404. */
          <a
            href={documentDownloadUrl(document.id)}
            aria-label={t('download', { name })}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <DownloadIcon />
            {t('downloadShort')}
          </a>
        )
      )}
    </li>
  );
}

/**
 * The record's PDF documents (docs/documents.md, `GET <base>/{id}/documents`):
 * each with its state (queued, rendering, failed and why, issued with a
 * download), newest first, and a button to issue another in a language.
 * Refetched on the record's `document.ready`/`document.failed` and polled
 * while one runs (slower with a socket, as a safety net).
 * 503 `documents_unavailable` (the feature is off or Gotenberg is down)
 * hides the button and says so.
 */
export function DocumentsPanel(props: { base: string; id: string }) {
  const { t, i18n } = useTranslation('documents');
  const queryClient = useQueryClient();
  const locales = useFeatures()?.locales ?? [];
  const [chosen, setChosen] = useState<string>();
  const lang =
    chosen ??
    (locales.includes(i18n.language as never) ? i18n.language : locales[0]) ??
    i18n.language;
  const [unavailable, setUnavailable] = useState(false);
  const live = useRealtime() !== undefined;
  const key = panelKeys.documents(props.base, props.id);
  const query = useQuery({
    queryKey: key,
    queryFn: () => listDocuments(props.base, props.id),
    refetchInterval: (q) =>
      q.state.data?.some(
        (document) =>
          document.status === 'queued' || document.status === 'rendering',
      )
        ? live
          ? 10_000
          : 1500
        : false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const settle = (event: { recordId: string }) => {
    if (event.recordId === props.id) void refresh();
  };
  useRealtimeEvent('document.ready', settle);
  useRealtimeEvent('document.failed', settle);

  const issue = useMutation({
    mutationFn: () => issueDocument(props.base, props.id, lang),
    meta: { errorToast: false },
    onSuccess: () => refresh(),
    onError: (error) => {
      if (isApiError(error) && error.code === 'documents_unavailable') {
        setUnavailable(true);
      } else if (isApiError(error) && error.code === 'document_pending') {
        // Already being made in this language: it is in the list.
        void refresh();
        toast.info(t('pending'));
      } else {
        toast.error(errorMessage(error));
      }
    },
  });

  const documents = query.data ?? [];
  return (
    <div className="flex flex-col gap-4">
      {unavailable ? (
        <Alert role="alert">
          <CircleAlertIcon />
          <AlertDescription>{t('unavailable')}</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          {locales.length > 1 && (
            <Field className="w-48">
              <FieldLabel htmlFor="document-language">
                {t('language')}
              </FieldLabel>
              <Select
                items={locales.map((code) => ({
                  value: code,
                  label: languageName(code),
                }))}
                value={lang}
                onValueChange={(value) => setChosen(value ?? undefined)}
              >
                <SelectTrigger id="document-language" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {locales.map((code) => (
                    <SelectItem key={code} value={code}>
                      {languageName(code)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Button disabled={issue.isPending} onClick={() => issue.mutate()}>
            {issue.isPending ? <Spinner /> : <FileTextIcon />}
            {t('issue')}
          </Button>
        </div>
      )}
      {query.isPending ? (
        <Skeleton className="h-16 w-full" aria-busy />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('error')}
        </p>
      ) : documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('title')}>
          {documents.map((document) => (
            <DocumentRow key={document.id} document={document} />
          ))}
        </ul>
      )}
    </div>
  );
}
