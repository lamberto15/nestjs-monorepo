import { databaseConfig } from './database.config.js';

describe('the database roles outside production', () => {
  afterEach(() => vi.unstubAllEnvs());

  it("are compose.dev.yaml's, on DATABASE_URL's server, port and database", () => {
    // A second project's services, on ports of their own (docs/development.md).
    vi.stubEnv(
      'DATABASE_URL',
      'postgres://app_runtime:app_runtime@127.0.0.1:15432/app',
    );
    vi.stubEnv('DATABASE_OWNER_URL', '');
    vi.stubEnv('DATABASE_MAINTENANCE_URL', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect(databaseConfig()).toMatchObject({
      ownerUrl: 'postgres://app:app@127.0.0.1:15432/app',
      maintenanceUrl:
        'postgres://app_maintenance:app_maintenance@127.0.0.1:15432/app',
    });
  });

  it('are none in production unless given', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://app_runtime:secret@db:5432/app');
    vi.stubEnv('DATABASE_OWNER_URL', '');
    vi.stubEnv('DATABASE_MAINTENANCE_URL', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(databaseConfig()).toMatchObject({
      ownerUrl: undefined,
      maintenanceUrl: undefined,
    });
  });
});
