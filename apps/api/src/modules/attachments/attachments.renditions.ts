import { RENDITION_NAMES, type RenditionName } from '../images/renditions.js';

/**
 * A derived file of an image attachment as the row keeps it: where it is on
 * the private disk, and what it is. The processor (modules/images) makes the
 * bytes; where they are kept is the attachments' business.
 */
export interface StoredRendition {
  key: string;
  /** Bytes. */
  size: number;
  /** Pixels (after rotating it upright). */
  width: number;
  height: number;
  contentType: string;
}
export type StoredRenditions = Partial<Record<RenditionName, StoredRendition>>;

/**
 * `pending`: queued (or running); the original can be downloaded meanwhile.
 * `ready`: the renditions exist (and the original's metadata is gone, unless
 * IMAGE_STRIP_ORIGINALS is off). `failed`: the image could not be processed;
 * the original is as it was uploaded. Null: not an image to process, or
 * IMAGE_PROCESSING was off at upload.
 */
export type RenditionStatus = 'pending' | 'ready' | 'failed';

/** What a client is told of a rendition: its shape, never where it is stored. */
export function publicRenditions(renditions: StoredRenditions) {
  const shown: Partial<Record<RenditionName, Omit<StoredRendition, 'key'>>> =
    {};
  for (const name of RENDITION_NAMES) {
    const rendition = renditions[name];
    if (rendition) {
      const { key: _key, ...rest } = rendition;
      shown[name] = rest;
    }
  }
  return shown;
}

/** The keys of the files a row's renditions are stored under. */
export const renditionKeys = (renditions: StoredRenditions): string[] =>
  Object.values(renditions).map((rendition) => rendition.key);
