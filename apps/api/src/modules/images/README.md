# modules/images

`ImageProcessor` (sharp): `process(bytes)` returns a `thumb` (256 px) and a
`preview` (1600 px) as upright WebP without metadata, and, when the original
carries EXIF, XMP, IPTC or text chunks, a copy without them (`stripped`). It
knows nothing of storage or tenants; the module that stores files calls it.

Untrusted input: JPEG, PNG, WebP and GIF only (by the bytes), pixel count
checked from the header, at most 64 MiB loaded, a time limit per
conversion, a damaged file is refused, an animated or 16-bit original keeps
its metadata, and a copy without it more than four times the original's size
is refused.
Failures are `ImageRejectedError` with a `reason` (`pixels`, `size`, `format`,
`timeout`, `invalid`). sharp loads on the first image, not at boot.

## Variables (`images.config.ts`)

IMAGE_MAX_PIXELS (50000000), IMAGE_TIMEOUT_MS (30000), IMAGE_STRIP_ORIGINALS (`on`).

## Remove

`pnpm module:remove images` ([removing-a-module](../../../../../docs/removing-a-module.md)).
