import { unwrap } from '@nestjs-monorepo/api-client';
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';

/** The person's recently opened records, newest first (GET /v1/recents). */
export const recentsQuery = queryOptions({
  queryKey: ['work', 'recents'],
  queryFn: () => unwrap(api.GET('/v1/recents')),
});

export function useClearRecents() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.DELETE('/v1/recents')),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: recentsQuery.queryKey }),
  });
}

/**
 * Notes that the person opened a record, once when its page shows (the
 * title only, never field content). Best effort: a failure is ignored (a
 * subject whose records can't be watched has no recents).
 * @public Used by a generated feature's pages (web-feature/templates.js).
 */
export function useRecordRecent(record: {
  subject: string;
  recordId: string;
  label: string;
}) {
  const queryClient = useQueryClient();
  const { subject, recordId, label } = record;
  useEffect(() => {
    void api
      .POST('/v1/recents', { body: { subject, recordId, label } })
      .then(() =>
        queryClient.invalidateQueries({ queryKey: recentsQuery.queryKey }),
      )
      .catch(() => undefined);
  }, [queryClient, subject, recordId, label]);
}
