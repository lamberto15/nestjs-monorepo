# modules/images

`ImageProcessor` (sharp): `process(bytes)` returns a `thumb` (256 px) and a
`preview` (1600 px) as upright WebP without metadata, and, when the original
carries EXIF, XMP, IPTC or text chunks, a copy without them (`stripped`). It
knows nothing of storage or tenants; the module that stores files calls it.

Untrusted input: JPEG, PNG, WebP and GIF only (by the bytes), pixel count
checked from the header, a time limit per conversion, a damaged file is
refused, an animated PNG or a copy much larger than the original is left alone.
Failures are `ImageRejectedError` with a `reason` (`pixels`, `size`, `format`,
`timeout`, `invalid`). sharp loads on the first image, not at boot.

## Variables (`images.config.ts`)

IMAGE_MAX_PIXELS (50000000), IMAGE_TIMEOUT_MS (30000), IMAGE_STRIP_ORIGINALS (`on`).

## Remove

Delete this folder and its line in `app.module.ts`.
