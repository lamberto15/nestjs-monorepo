# core/web

The built web app, served by the API from its own origin (`@nestjs/serve-static`): one image, one origin, no reverse proxy needed in front for the pages. HTTPS and certificates are the host's job.

- **What is served:** the files of `WEB_ROOT` (`apps/web/dist`), and its `index.html` on every other GET the API doesn't own, so a page of the app opens on a reload. Unset, the API serves no web app (API only; `pnpm dev` runs Vite, which proxies the API).
- **The API's paths** never answer the page: `/v1` and every other version, `/health`, `/metrics`, `/api`, `/api-json`, `/api-yaml`, `/files`, `/socket.io`, `/.well-known` (`API_PATHS` in `web.config.ts`). A new unversioned route is added there. A missing file under `/assets` is a 404, not the page.
- **Caching:** `/assets/*` (named by content) for a year, immutable; everything else `no-cache`, so a deploy shows at the next load.
- **Headers of the page:** its own Content-Security-Policy (scripts from this origin and Turnstile's; files from this origin and `WEB_FILES_ORIGINS`), `X-Frame-Options: DENY` and a Permissions-Policy that keeps passkeys. The API's responses keep the stricter default of core/http.

- **security.txt:** `/.well-known/security.txt` (RFC 9116) from SECURITY_CONTACT (an address, made `mailto:`, or an `https://` page), with `Expires` SECURITY_TXT_EXPIRES or else 180 days ahead; a 404 when no contact is set. Served with or without WEB_ROOT.

Variables (`web.config.ts`): WEB_ROOT, WEB_FILES_ORIGINS (the bucket's origin when browsers upload and download there directly), SECURITY_CONTACT, SECURITY_TXT_EXPIRES.

Remove (an API with no web app): delete this folder and its line in `app.module.ts`.
