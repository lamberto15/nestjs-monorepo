import { sep } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { SecurityTxtController } from './security-txt.controller.js';
import { API_PATHS, webConfig } from './web.config.js';

/** What a response's headers are set on (the adapter's response). */
interface Headers {
  setHeader(name: string, value: string): unknown;
}

/**
 * The page's Content-Security-Policy: scripts from this origin and the
 * captcha's (Turnstile), files from this origin and WEB_FILES_ORIGINS.
 * The API's own responses keep the stricter default (core/http).
 */
export function pagePolicy(filesOrigins: readonly string[]) {
  const files = filesOrigins.join(' ');
  return [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    'frame-src https://challenges.cloudflare.com',
    `connect-src 'self' ${files}`.trim(),
    `img-src 'self' data: blob: ${files}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Serves the built web app (WEB_ROOT) from the API's own origin
 * (`@nestjs/serve-static`): its files, and `index.html` on every other path
 * the API doesn't own, so the app's own routes open on a reload. One image
 * and one origin: the session cookie needs no CORS.
 */
@Module({
  imports: [
    ServeStaticModule.forRootAsync({
      imports: [ConfigModule.forFeature(webConfig)],
      inject: [webConfig.KEY],
      useFactory: (config: ConfigType<typeof webConfig>) => {
        if (!config.root) {
          return [];
        }
        const policy = pagePolicy(config.filesOrigins);
        return [
          {
            rootPath: config.root,
            exclude: API_PATHS,
            serveStaticOptions: {
              setHeaders: (res: Headers, path: string) => {
                if (path.includes(`${sep}assets${sep}`)) {
                  // Vite names them by their content: a new build, a new name.
                  res.setHeader(
                    'Cache-Control',
                    'public, max-age=31536000, immutable',
                  );
                  return;
                }
                // The page, the service worker, version.json: asked again
                // each time, so a deploy shows at the next load.
                res.setHeader('Cache-Control', 'no-cache');
                if (path.endsWith('.html')) {
                  res.setHeader('Content-Security-Policy', policy);
                  res.setHeader('X-Frame-Options', 'DENY');
                  res.setHeader(
                    'Permissions-Policy',
                    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
                  );
                }
              },
            },
          },
        ];
      },
    }),
    ConfigModule.forFeature(webConfig),
  ],
  // With or without WEB_ROOT: an API alone has a contact too.
  controllers: [SecurityTxtController],
})
export class WebModule {}
