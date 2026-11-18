import type { StorageDisk } from '@nestjs/storage';

/** How long a download link works at most. */
export const TRANSFER_LINK_TTL_MS = 30 * 60 * 1000;

/**
 * How long a finished transfer is kept, its file included: listed, found,
 * its link given (BullMQ's `removeOnComplete` and `removeOnFail`, the
 * `expiresAt` shown, the links, the sweep of the transfers' files, the
 * delayed deletion of an account export's file).
 */
export const TRANSFER_KEPT_MS = 7 * 24 * 3600 * 1000;

/** The two durations as the route descriptions say them: derived, never written out. */
export const LINK_LASTS = `${TRANSFER_LINK_TTL_MS / 60_000} minutes`;
export const TRANSFERS_KEPT = `${TRANSFER_KEPT_MS / 86_400_000} days`;

/** The shortest link a disk signs (`@nestjs/storage`: 1 second). */
const SHORTEST_LINK_MS = 1000;

/** When a transfer that finished at `finishedAt` (ms) is no longer kept. */
export const keptUntil = (finishedAt: number) => finishedAt + TRANSFER_KEPT_MS;

/**
 * A link to a finished transfer's file, or undefined once the transfer is
 * no longer kept: the link works for TRANSFER_LINK_TTL_MS, never past
 * `keptUntil()`.
 */
export async function linkWhileKept(
  disk: StorageDisk,
  key: string,
  finishedAt: number,
  now = Date.now(),
) {
  const left = Math.min(TRANSFER_LINK_TTL_MS, keptUntil(finishedAt) - now);
  return left >= SHORTEST_LINK_MS
    ? disk.signedUrl(key, { expiresIn: left })
    : undefined;
}

/**
 * Deletes the files under `prefix` written longer ago than TRANSFER_KEPT_MS,
 * and answers how many. A file is written when its transfer ends, so its age
 * is the transfer's.
 */
export async function deleteUnkept(
  disk: StorageDisk,
  prefix: string,
  now: Date,
) {
  const before = now.getTime() - TRANSFER_KEPT_MS;
  const keys: string[] = [];
  for await (const entry of disk.listAll({ prefix })) {
    if (entry.lastModified.getTime() < before) {
      keys.push(entry.key);
    }
  }
  if (keys.length) await disk.delete(keys);
  return keys.length;
}
