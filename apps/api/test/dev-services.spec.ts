import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devServices } from './dev-services.js';

describe("the tests' development services", () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-services-'));
  afterAll(() => rmSync(root, { recursive: true }));

  it("are compose.dev.yaml's defaults without the root .env", () => {
    expect(devServices(root)).toEqual({
      postgresUrl: 'postgres://app:app@127.0.0.1:5432/app',
      redisUrl: 'redis://127.0.0.1:6379',
    });
  });

  it('are on the ports `pnpm run setup --dev-ports` wrote there', () => {
    writeFileSync(
      join(root, '.env'),
      'COMPOSE_PROJECT_NAME=second-dev\nPOSTGRES_PORT=5433\nREDIS_PORT=6380\n',
    );
    expect(devServices(root)).toEqual({
      postgresUrl: 'postgres://app:app@127.0.0.1:5433/app',
      redisUrl: 'redis://127.0.0.1:6380',
    });
  });
});
