import { buffer } from 'node:stream/consumers';
import {
  BadRequestException,
  ConflictException,
  type HttpException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { type StorageDisk, StorageFileNotFoundError } from '@nestjs/storage';
import {
  assertDeclaredType,
  ATTACHMENT_SAMPLE_BYTES,
  detectUploadedType,
  isAllowedType,
  sameType,
} from './attachments.types.js';

/** What an upload may be: the limits an upload through the API is refused by. */
export interface UploadLimits {
  maxBytes: number;
  types: readonly string[];
}

/**
 * What reading an object that was PUT to a signed URL (or assembled from a
 * session's parts) found: a file that is what was announced (with the type its
 * bytes say), or a refusal. `keep`: the refusal is "not there yet", so the
 * announced upload stays; otherwise the object is to be deleted.
 */
export type UploadVerdict =
  | { ok: true; size: number; contentType: string }
  | { ok: false; keep: boolean; error: HttpException };

/** 409: nothing was PUT to the upload's URL yet, or bytes of a session are missing; the upload stays, try again. */
export const uploadIncomplete = () =>
  new ConflictException({
    code: 'attachment_upload_incomplete',
    message:
      'The file has not arrived in storage: PUT it to the upload URL first.',
  });

/**
 * Reads an object back from the store and compares it with what was
 * announced (`expected`): its size and `Content-Type` by HEAD, then its first
 * ATTACHMENT_SAMPLE_BYTES by a ranged GET, typed as an upload through the API
 * is (`detectUploadedType`). The type the bytes say must be allowed and must
 * not contradict the declared one: the declared type is the client's word.
 * Throws only when the store cannot be asked (the caller tries again later).
 */
export async function checkUploadedObject(
  disk: StorageDisk,
  expected: { key: string; size: number; contentType: string },
  limits: UploadLimits,
): Promise<UploadVerdict> {
  const refuse = (error: HttpException): UploadVerdict => ({
    ok: false,
    keep: false,
    error,
  });
  let file;
  try {
    file = await disk.stat(expected.key);
  } catch (error) {
    if (error instanceof StorageFileNotFoundError) {
      return { ok: false, keep: true, error: uploadIncomplete() };
    }
    throw error;
  }
  // The limit may be lower than when the URL was signed.
  if (file.size > limits.maxBytes) {
    return refuse(new PayloadTooLargeException('File too large'));
  }
  if (
    file.size !== expected.size ||
    !sameType(file.contentType, expected.contentType)
  ) {
    return refuse(
      new BadRequestException({
        code: 'attachment_upload_mismatch',
        message:
          'The uploaded file is not the size and type that were announced.',
      }),
    );
  }
  const { body } = await disk.get(expected.key, {
    range: { start: 0, end: ATTACHMENT_SAMPLE_BYTES - 1 },
  });
  const detected = detectUploadedType(await buffer(body), expected.contentType);
  if (!detected || !isAllowedType(detected, limits.types)) {
    return refuse(
      new UnsupportedMediaTypeException(
        `File type not allowed. Allowed types: ${limits.types.join(', ')}`,
      ),
    );
  }
  try {
    assertDeclaredType(expected.contentType, detected);
  } catch (error) {
    return refuse(error as HttpException);
  }
  return { ok: true, size: file.size, contentType: detected };
}
