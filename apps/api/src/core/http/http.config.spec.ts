import { httpConfig } from './http.config.js';

describe('http config', () => {
  const load = (env: Record<string, string>) => {
    const saved = { ...process.env };
    delete process.env.OPENAPI;
    Object.assign(process.env, env);
    try {
      return httpConfig();
    } finally {
      process.env = saved;
    }
  };

  it('serves OpenAPI outside production, and in production only when asked', () => {
    expect(load({ NODE_ENV: 'development' }).openApi).toBe(true);
    expect(load({ NODE_ENV: 'production' }).openApi).toBe(false);
    expect(load({ NODE_ENV: 'production', OPENAPI: 'on' }).openApi).toBe(true);
    expect(load({ NODE_ENV: 'development', OPENAPI: 'off' }).openApi).toBe(
      false,
    );
  });
});
