import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useRealtimeEvent } from '@/lib/realtime';
import { ApiError, unwrap } from '@nestjs-monorepo/api-client';
import { api } from '@/lib/api';
import { postMultipart, putFile, StoreUnreachableError } from '@/lib/upload';
import {
  call,
  allPages,
  PAGE_SIZE,
  type Schemas,
  panelKeys,
} from '@/components/records/panels/api';

export type Attachment = Schemas['Attachment'];
type PresignedUpload = Schemas['PresignedUpload'];
/** What a file may be, as the upload route enforces it (`attachmentLimits` of `GET /v1/lists/{subject}`). */
export type AttachmentLimits = Schemas['AttachmentLimits'];

/** The files' query key, under the record's panels (`panelKeys.all`). */
export const attachmentKeys = (base: string, id: string) =>
  [...panelKeys.all(base, id), 'attachments'] as const;

export const listAttachments = (base: string, id: string) =>
  allPages((cursor) =>
    unwrap(
      call<Schemas['AttachmentPage']>('GET', base, '/attachments', {
        params: { path: { id }, query: { limit: PAGE_SIZE, cursor } },
      }),
    ),
  );

/** `GET /v1/attachments/{id}/download` redirects to a signed link: a plain link follows it. */
export const downloadUrl = (attachmentId: string) =>
  `/v1/attachments/${attachmentId}/download`;

/**
 * An image's smaller copy (`thumb` 256 px, `preview` 1600 px, WebP: docs/attachments.md,
 * "Image renditions"). Like the download, it redirects to a signed link, which an
 * `<img>` follows only to an origin the page may load images from (the dev proxy,
 * Caddy's `img-src`: docs/attachments.md). 404 while the image is not `ready`.
 */
export const renditionUrl = (
  attachmentId: string,
  rendition: 'thumb' | 'preview',
) => `${downloadUrl(attachmentId)}?rendition=${rendition}`;

export const removeAttachment = (attachmentId: string) =>
  unwrap(
    api.DELETE('/v1/attachments/{id}', {
      params: { path: { id: attachmentId } },
    }),
  );

/**
 * Uploads one file with progress for the dropzone (docs/attachments.md).
 *
 * `direct` (`GET /v1/features`: `presignedUploads`, `STORAGE_DRIVER=s3`): the
 * file goes straight to the object store, which spares the API its bytes:
 * `…/attachments/presign` for a signed URL, a PUT of the file to it, then
 * `…/attachments/complete`, which attaches it after the server checked what
 * arrived. Otherwise, and whenever a direct upload cannot be tried (the
 * browser cannot name the file's type, which a signed URL is bound to; the
 * server answered 503 `presigned_uploads_unavailable` meanwhile, or 429
 * `attachment_uploads_pending`; the browser cannot reach the store, say a
 * bucket with no CORS rule for this origin),
 * the file goes as multipart through the API, which works with every driver.
 */
export async function uploadAttachment(
  base: string,
  id: string,
  file: File,
  onProgress: (percent: number) => void,
  direct = false,
): Promise<Attachment> {
  if (direct && file.type) {
    try {
      return await uploadDirect(base, id, file, onProgress);
    } catch (error) {
      // The multipart upload leaves no announcement behind, so a user who
      // has many open (attachment_uploads_pending) can still attach files.
      const fallback =
        error instanceof StoreUnreachableError ||
        (error instanceof ApiError &&
          (error.code === 'presigned_uploads_unavailable' ||
            error.code === 'attachment_uploads_pending'));
      if (!fallback) throw error;
      onProgress(0);
    }
  }
  const form = new FormData();
  form.append('file', file);
  return postMultipart<Attachment>(
    `${base}/attachments`.replace('{id}', id),
    form,
    onProgress,
  );
}

async function uploadDirect(
  base: string,
  id: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<Attachment> {
  const upload = await unwrap(
    call<PresignedUpload>('POST', base, '/attachments/presign', {
      params: { path: { id } },
      body: { name: file.name, size: file.size, contentType: file.type },
    }),
  );
  await putFile(upload.url, upload.headers, file, onProgress);
  return unwrap(
    call<Attachment>('POST', base, '/attachments/complete', {
      params: { path: { id } },
      body: { uploadId: upload.uploadId },
    }),
  );
}

/**
 * Reloads the files on the record's `record.attachments.changed`, while the
 * record's panels are open. An upload the malware scan flagged is deleted,
 * not marked (docs/attachments.md): its uploader is told why here (the API's
 * notification, in their language) while a record of the subject is open;
 * the bell has it anywhere else. The notification also reloads the list:
 * the `removed` event goes to the record's watchers only, and the uploader
 * may not be one. It names no record, so the open one is read again (a rare
 * event, one cheap read).
 */
export function useAttachmentsLive(subject: string, base: string, id: string) {
  const queryClient = useQueryClient();
  const reload = () =>
    void queryClient.invalidateQueries({ queryKey: attachmentKeys(base, id) });
  useRealtimeEvent('record.attachments.changed', (event) => {
    if (event.subject === subject && event.recordId === id) reload();
  });
  useRealtimeEvent('notification', (event) => {
    if (
      event.type === 'attachment.rejected' &&
      event.data.subject === subject
    ) {
      toast.error(event.title, { description: event.body });
      reload();
    }
  });
}
