import { randomUUID } from 'node:crypto';
import { PasswordHasher, TokenService } from '@nestjs/authentication';
import { getDrizzleToken } from '@nestjs/drizzle';
import { EventEmitterModule } from '@nestjs/event-emitter';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { DatabaseModule } from '../src/core/database/database.module.js';
import { EncryptionModule } from '../src/core/encryption/encryption.module.js';
import { I18nModule } from '../src/core/i18n/i18n.module.js';
import { SharedLocksModule } from '../src/core/locks/locks.module.js';
import { RedisModule } from '../src/core/redis/redis.module.js';
import { TenancyModule } from '../src/core/tenancy/tenancy.module.js';
import { Tenancy } from '../src/core/tenancy/tenancy.service.js';
import { ThrottlingModule } from '../src/core/throttling/throttling.module.js';
import { AuditModule } from '../src/iam/audit/audit.module.js';
import {
  generateApiKey,
  apiKeyId,
  hashApiKey,
} from '../src/iam/auth/api-keys.js';
import { AuthModule } from '../src/iam/auth/auth.module.js';
import {
  apiClients,
  apiKeys,
  memberships,
  users,
} from '../src/iam/auth/auth.tables.js';
import { tokenClaims } from '../src/iam/auth/authentication-method.js';
import type { Database } from '../src/core/database/database.js';

/**
 * What an e2e test boots around the module it tests to have principals:
 * `bootModules(...authModules(), MyModule)`. The audit log comes with it
 * (sign-ins are recorded). Jobs don't run (set SCHEDULER=off in the test, or
 * call them).
 */
export const authModules = () => [
  EventEmitterModule.forRoot(),
  DatabaseModule,
  TenancyModule,
  RedisModule,
  ThrottlingModule,
  I18nModule,
  EncryptionModule,
  SharedLocksModule,
  AuthModule,
  AuditModule,
];

/** The password every test user has: long enough for any later policy. */
export const TEST_PASSWORD = 'correct horse battery staple';

/**
 * A tenant (made, or the one given) with a member who has a password and a
 * verified address. Not signed in: `signIn()` that, or use
 * `signedInUser()`.
 */
export async function createUser(
  app: NestNodeApplication,
  {
    tenantId,
    email = `user-${randomUUID()}@acme.dev`,
    password = TEST_PASSWORD,
    emailVerified = true,
    name = 'Test User',
  }: {
    tenantId?: string;
    email?: string;
    password?: string;
    emailVerified?: boolean;
    name?: string;
  } = {},
) {
  const tenancy = app.get(Tenancy);
  const tenant =
    tenantId ??
    (
      await tenancy.create({
        slug: `t-${randomUUID().slice(0, 8)}`,
        name: 'Test tenant',
      })
    ).id;
  const db = database(app);
  const [user] = await db
    .insert(users)
    .values({
      email: email.toLowerCase(),
      name,
      emailVerified,
      passwordHash: await app.get(PasswordHasher).hash(password),
    })
    .returning();
  await db.insert(memberships).values({ tenantId: tenant, userId: user!.id });
  return { user: user!, tenantId: tenant, email: user!.email, password };
}

/** Signs in with a password: the session cookie, as the headers to pass to `app.inject()`. */
export async function signIn(
  app: NestNodeApplication,
  email: string,
  password = TEST_PASSWORD,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Sign-in failed: ${response.statusCode} ${response.body}`);
  }
  const cookie = cookieOf(response.headers['set-cookie']);
  return { cookie, headers: { cookie } };
}

/**
 * A tenant with a signed-in member: `app.inject({ ..., headers })` acts as
 * them, in that tenant.
 */
export async function signedInUser(
  app: NestNodeApplication,
  options: Parameters<typeof createUser>[1] = {},
) {
  const created = await createUser(app, options);
  return {
    ...created,
    ...(await signIn(app, created.email, created.password)),
  };
}

/** An access token for the user (a token client's), as the headers to pass. */
export async function accessTokenFor(
  app: NestNodeApplication,
  userId: string,
  tenantId: string | null,
) {
  const issued = await app.get(TokenService).issue(userId, {
    method: 'password',
    claims: tokenClaims(['pwd'], new Date(), tenantId),
  });
  return {
    ...issued,
    headers: { authorization: `Bearer ${issued.accessToken}` },
  };
}

/**
 * An API client of the tenant with a key: `app.inject({ ..., headers })`
 * acts as the client.
 */
export async function apiClient(
  app: NestNodeApplication,
  tenantId: string,
  {
    name = `client-${randomUUID().slice(0, 8)}`,
    allowedCidrs = [],
    expiresAt = null,
  }: { name?: string; allowedCidrs?: string[]; expiresAt?: Date | null } = {},
) {
  const db = database(app);
  const [client] = await app
    .get(Tenancy)
    .run(tenantId, () =>
      db.insert(apiClients).values({ name, allowedCidrs }).returning(),
    );
  const key = generateApiKey();
  await db.insert(apiKeys).values({
    tenantId,
    clientId: client!.id,
    keyId: apiKeyId(key)!,
    keyHash: hashApiKey(key),
    expiresAt,
  });
  return { client: client!, key, headers: { authorization: `Bearer ${key}` } };
}

/** The `name=value` of the session cookie a response set. */
export function cookieOf(setCookie: string | string[] | undefined) {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const pair = first?.split(';')[0];
  if (!pair) {
    throw new Error('The response set no cookie.');
  }
  return pair;
}

/** The app's database (bound to the scope of the work, as every query). */
function database(app: NestNodeApplication): Database {
  return app.get<Database>(getDrizzleToken());
}
