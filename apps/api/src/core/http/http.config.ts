import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { flag, list, optional, secret } from '../config/env.helpers.js';
import { readEnv } from '../config/env.js';

export const schema = z.object({
  /**
   * Browser apps on other origins (`https://admin.example.com`, comma-separated):
   * CORS, and the origins allowed to send cookie-authenticated writes (CSRF).
   */
  CORS_ORIGINS: list(),
  /**
   * The keys sorted lists' cursors are sealed with, newest first,
   * comma-separated (each `openssl rand -base64 32`). Every instance needs
   * the same; unset, each process makes its own, whose cursors no other opens.
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
    corsOrigins: env.CORS_ORIGINS,
    cursorKeys: env.CURSOR_KEYS,
    openApi: env.OPENAPI,
    production: env.NODE_ENV === 'production',
  };
});
