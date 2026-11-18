import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';
import { list, optional } from '../config/env.helpers.js';

export const schema = z.object({
  /**
   * The folder of the built web app (`apps/web/dist`: its `index.html`),
   * served on every path the API doesn't own. Unset, the API serves no web
   * app. The image sets it.
   */
  WEB_ROOT: optional(),
  /**
   * Other origins the web app may load files from and send them to
   * (`https://files.example.com`, comma-separated): the bucket's, when
   * browsers upload and download there directly (STORAGE_DRIVER=s3).
   */
  WEB_FILES_ORIGINS: list(),
});

export const webConfig = registerAs('web', () => {
  const env = readEnv(schema);
  return { root: env.WEB_ROOT, filesOrigins: env.WEB_FILES_ORIGINS };
});

/**
 * The paths the API owns, which never fall back to the web app's page:
 * the versioned routes and the unversioned ones (`VERSION_NEUTRAL`
 * controllers, Swagger UI, the sockets). A new unversioned route is added
 * here, or its GET answers the web app's page.
 */
export const API_PATHS =
  /^\/(?:v\d+|health|metrics|api|api-json|api-yaml|files|socket\.io|\.well-known|assets)(?:\/|$)/;
