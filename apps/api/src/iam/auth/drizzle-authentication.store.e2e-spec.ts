import { authenticationStoreContract } from '@nestjs/authentication/testing';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import { authModules } from '../../../test/auth.js';
import { DrizzleAuthenticationStore } from './drizzle-authentication.store.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
});

/** The package's own rules for a session and refresh-token store, races included. */
describe('DrizzleAuthenticationStore (e2e)', async () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(...authModules());
  });
  afterAll(async () => {
    await app.close();
  });

  const cases = authenticationStoreContract(
    () => {
      const store = app.get(DrizzleAuthenticationStore);
      return { sessions: store, refreshTokens: store };
    },
    { contracts: ['sessions', 'refreshTokens'], concurrent: true },
  );
  for (const contractCase of cases) {
    it(contractCase.name, () => contractCase.run());
  }
});
