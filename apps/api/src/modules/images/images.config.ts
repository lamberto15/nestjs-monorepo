import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { flag, integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /**
   * Pixels of one frame (width × height) an image may have to be processed;
   * more is refused from its header, before a pixel is decoded (a
   * decompression bomb: 50 KB of PNG can claim gigapixels). Memory is about
   * 4 bytes per pixel while one image is converted.
   */
  IMAGE_MAX_PIXELS: integer(50_000_000, { min: 1_000, max: 268_402_689 }),
  /** One conversion's limit, in milliseconds; an image that takes longer is refused. */
  IMAGE_TIMEOUT_MS: integer(30_000, { min: 1000 }),
  /**
   * `on`: an original that carries metadata (EXIF, GPS, XMP, IPTC) is
   * replaced by a copy without it (re-encoded: JPEG and WebP at quality 90,
   * upright). `off`: originals stay byte for byte as uploaded; only the
   * renditions are stripped.
   */
  IMAGE_STRIP_ORIGINALS: flag('on'),
});

export const imagesConfig = registerAs('images', () => {
  const env = readEnv(schema);
  return {
    maxPixels: env.IMAGE_MAX_PIXELS,
    timeoutMs: env.IMAGE_TIMEOUT_MS,
    stripOriginals: env.IMAGE_STRIP_ORIGINALS,
  };
});
