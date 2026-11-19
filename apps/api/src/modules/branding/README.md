# modules/branding

A tenant's name, colours and logos: what the web app, its mail and its
documents show for the tenant.

- **Colour and sender name** are settings (`branding.primaryColor`,
  `branding.darkPrimaryColor`, `branding.mailFromName`, tenant scope): the
  same schemas and audit entries whether set through `/v1/branding` or
  `/v1/settings`. A colour is `#rrggbb` only; a name has no control
  characters, `< > " \ @ ; , :`.
- **Logos** (the logo, and an optional dark-mode one): PNG, JPEG or WebP up to
  512 KB, recognized by their bytes (never SVG), streamed to the private disk
  at a new key of the tenant's (`tenants/<id>/branding/…`), then checked and
  stripped of metadata by `modules/images`. One row per variant in
  `branding_logos`; a new upload replaces the file. A replaced or removed
  file is deleted once the change commits (modules/storage's `StoredFiles`).
  Audited: `branding.logo-changed`, `branding.logo-removed`.
- **The operators' lock** (`branding.locked`, platform scope only): while on,
  the values and logos answer 409 `branding_locked`, on `/v1/branding` and on
  the settings API. Operators may also enforce values at the platform scope.
- **Custom domains** are `iam/tenants` (`/v1/branding/domains`). Branding only
  answers the brand of the host: it finds the `@HostTenantResolver()` by
  discovery.

## Routes

- `GET /v1/branding` (anyone signed in): the tenant's branding, `locked`,
  `canEdit`. `PUT /v1/branding`: `{ primaryColor?, darkPrimaryColor?,
mailFromName? }` (`null` removes). `Branding.update`.
- `POST|DELETE /v1/branding/logo` and `/logo/dark` (multipart field `file`).
  `Branding.update`.
- `GET /v1/branding/{tenantId}/logo` and `/logo/dark` (public): the image, with
  `nosniff`, a locked-down CSP and `Cross-Origin-Resource-Policy: cross-origin`.
- `GET /v1/branding/host` (public): the brand of the custom domain the request
  came to, every field null on any other host.

## Using it

`BrandingService` is marked `@MailBrand()`: core/mail reads `current()` when it renders a mail for a tenant (the layout shows the colour, name and logo). `current()` gives mail `{ name, color, logoUrl }` for the
tenant in scope; `forDocument()` gives a document `{ name, color, logo }`
with the logo as a `data:` URL. Import `BrandingModule`; it needs
StorageModule (the disk), and the settings, images and access modules.

## Removing it

Delete the folder and its line in `app.module.ts`.
