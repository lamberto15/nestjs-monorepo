import { useQueryClient } from '@tanstack/react-query';
import { useRealtimeEvent } from '@/lib/realtime';
import { unwrap } from '@nestjs-monorepo/api-client';
import {
  call,
  allPages,
  PAGE_SIZE,
  type Schemas,
  panelKeys,
} from '@/components/records/panels/api';

export type Comment = Schemas['Comment'];

/** The thread's query key, under the record's panels (`panelKeys.all`). */
export const commentKeys = (base: string, id: string) =>
  [...panelKeys.all(base, id), 'comments'] as const;

/** The thread, oldest first (the newest last). */
export const listComments = (base: string, id: string) =>
  allPages((cursor) =>
    unwrap(
      call<Schemas['CommentPage']>('GET', base, '/comments', {
        params: {
          path: { id },
          query: { limit: PAGE_SIZE, sort: 'createdAt', cursor },
        },
      }),
    ),
  );

export const addComment = (base: string, id: string, body: string) =>
  unwrap(
    call<Comment>('POST', base, '/comments', {
      params: { path: { id } },
      body: { body },
    }),
  );

export const editComment = (
  base: string,
  id: string,
  commentId: string,
  body: string,
) =>
  unwrap(
    call<Comment>('PATCH', base, '/comments/{commentId}', {
      params: { path: { id, commentId } },
      body: { body },
    }),
  );

export const removeComment = (base: string, id: string, commentId: string) =>
  unwrap(
    call<unknown>('DELETE', base, '/comments/{commentId}', {
      params: { path: { id, commentId } },
    }),
  );

/**
 * Reloads the thread on the record's `record.commented` (docs/webhooks-and-realtime.md,
 * "Record events"), while the record's panels are open.
 */
export function useCommentsLive(subject: string, base: string, id: string) {
  const queryClient = useQueryClient();
  useRealtimeEvent('record.commented', (event) => {
    if (event.subject === subject && event.recordId === id) {
      void queryClient.invalidateQueries({ queryKey: commentKeys(base, id) });
    }
  });
}
