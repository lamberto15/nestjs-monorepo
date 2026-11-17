/**
 * The derived files of an uploaded image. Plain types and numbers, no image
 * library: the processor and the modules that store renditions read them.
 */

/**
 * What is made of an image: `thumb` for lists (fits in 256 × 256 pixels),
 * `preview` for a larger view (fits in 1600 × 1600). Never enlarged: an image
 * smaller than the box keeps its size. Both are WebP, rotated upright and
 * stripped of all metadata.
 */
export const RENDITION_NAMES = ['thumb', 'preview'] as const;
export type RenditionName = (typeof RENDITION_NAMES)[number];

export const RENDITION_SPECS: Record<
  RenditionName,
  {
    /** Longest side, in pixels. */ px: number;
    /** WebP quality (1 to 100). */ quality: number;
  }
> = {
  thumb: { px: 256, quality: 75 },
  preview: { px: 1600, quality: 80 },
};

/** Every rendition is a WebP (every current browser shows it, with transparency). */
export const RENDITION_CONTENT_TYPE = 'image/webp';

/**
 * The types that are processed, as the bytes were detected at upload. SVG is
 * not among them (it is not an image the storage package detects, and a
 * vector renderer has no business with uploads); AVIF and HEIC are skipped:
 * decoding them is heavy and the prebuilt library has no HEVC.
 */
export const IMAGE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/** Whether an image of this content type gets renditions. */
export const isProcessable = (contentType: string) =>
  IMAGE_INPUT_TYPES.has(contentType.split(';')[0]!.trim().toLowerCase());
