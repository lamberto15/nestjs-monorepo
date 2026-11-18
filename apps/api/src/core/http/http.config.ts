import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import {
  baseUrl,
  flag,
  list,
  optional,
  secret,
} from '../config/env.helpers.js';
import { readEnv } from '../config/env.js';

export const schema = z.object({
  /** The public origin of this API, for the links it hands out (signed file URLs, mails). */
  APP_URL: baseUrl('http://localhost:3000'),
  /**
   * The web app's base URL: the links in mails (reset, verification,
   * invitations, magic links) open its pages, and sign-ins (OIDC, SSO) land
   * on it. Unset: APP_URL (the API serves the web app).
   */
  WEB_URL: baseUrl(),
  /**
   * Browser apps on other origins (`https://admin.example.com`, comma-separated):
   * CORS, and the origins allowed to send cookie-authenticated writes (CSRF).
   */
  CORS_ORIGINS: list(),
  /**
   * The keys sorted lists' cursors are sealed with, newest first,
   * comma-separated (each `openssl rand -base64 32`). Every instance needs
   * the same; unset, one is made once and kept in the database (core/secrets),
   * so every instance reads the same.
   */
  CURSOR_KEYS: secret(list()),
  /** The OpenAPI document and Swagger UI at /api. */
  OPENAPI: flag('on'),
  /** `production` sends the strict Content-Security-Policy as it is. */
  NODE_ENV: optional(),
});

export const httpConfig = registerAs('http', () => {
  const env = readEnv(schema);
  return {
    appUrl: env.APP_URL!,
    webUrl: (env.WEB_URL ?? env.APP_URL)!,
    corsOrigins: env.CORS_ORIGINS,
    cursorKeys: env.CURSOR_KEYS,
    openApi: env.OPENAPI,
    production: env.NODE_ENV === 'production',
  };
});
