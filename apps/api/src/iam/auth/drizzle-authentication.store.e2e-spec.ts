import { randomUUID } from 'node:crypto';
import { authenticationStoreContract } from '@nestjs/authentication/testing';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import { authModules } from '../../../test/auth.js';
import type { Database } from '../../core/database/database.js';
import { refreshTokens, sessions } from './auth.tables.js';
import { DrizzleAuthenticationStore } from './drizzle-authentication.store.js';
import { SessionPruneJob } from './session-prune.job.js';

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

  it('the prune job deletes expired sessions and token families, and keeps live ones', async () => {
    const db = app.get<Database>(getDrizzleToken());
    const now = new Date();
    const past = new Date(now.getTime() - 60_000);
    const later = new Date(now.getTime() + 3_600_000);
    const userId = randomUUID();
    const session = (expiresAt: Date) => ({
      id: randomUUID(),
      userId,
      createdAt: past,
      expiresAt,
      lastActiveAt: past,
    });
    const token = (familyExpiresAt: Date) => ({
      id: randomUUID(),
      familyId: randomUUID(),
      userId,
      createdAt: past,
      expiresAt: familyExpiresAt,
      familyExpiresAt,
    });
    const [oldSession, liveSession] = [session(past), session(later)];
    const [oldToken, liveToken] = [token(past), token(later)];
    await db.insert(sessions).values([oldSession, liveSession]);
    await db.insert(refreshTokens).values([oldToken, liveToken]);

    expect(await app.get(SessionPruneJob).run(now)).toBeGreaterThanOrEqual(2);

    const store = app.get(DrizzleAuthenticationStore);
    expect(await store.getSession(oldSession.id)).toBeUndefined();
    expect(await store.getSession(liveSession.id)).toBeDefined();
    expect(await store.getRefreshToken(oldToken.id)).toBeUndefined();
    expect(await store.getRefreshToken(liveToken.id)).toBeDefined();
  });
});
