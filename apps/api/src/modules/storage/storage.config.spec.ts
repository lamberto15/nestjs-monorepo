import { storageConfig } from './storage.config.js';

describe('storageConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a local disk in a split deployment unless it is shared', () => {
    vi.stubEnv('STORAGE_DRIVER', 'local');
    vi.stubEnv('APP_ROLE', 'api');
    expect(() => storageConfig()).toThrow(/STORAGE_SHARED=on/);
    vi.stubEnv('STORAGE_SHARED', 'on');
    expect(storageConfig().driver).toBe('local');
  });

  it('takes a local disk in one process, and S3 anywhere', () => {
    vi.stubEnv('STORAGE_DRIVER', 'local');
    vi.stubEnv('APP_ROLE', 'all');
    expect(storageConfig().driver).toBe('local');
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('STORAGE_DRIVER', 's3');
    vi.stubEnv('S3_BUCKET', 'files');
    expect(storageConfig().driver).toBe('s3');
  });
});
