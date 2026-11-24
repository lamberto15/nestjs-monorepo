import { describe, expect, it } from 'vitest';
import { apiPathPattern } from './pwa-paths.ts';

describe('the service worker navigation denylist', () => {
  // What the API serves itself (docs/ of the API: routes, health,
  // Swagger UI and its documents, signed file links, the socket).
  it.each([
    '/v1/auth/me',
    '/health',
    '/api',
    '/api-json',
    '/api-yaml',
    '/files',
    '/files/x',
    '/socket.io/',
    '/.well-known/jwks.json',
  ])('leaves %s to the server', (path) => {
    expect(apiPathPattern.test(path)).toBe(true);
  });

  it.each(['/', '/sign-in', '/api-keys', '/files-list', '/healthy', '/v10'])(
    'serves the app shell for %s',
    (path) => {
      expect(apiPathPattern.test(path)).toBe(false);
    },
  );
});
