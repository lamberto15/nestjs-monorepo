import { createHash } from 'node:crypto';
import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { refreshTokens, sessions, users } from '../auth/auth.tables.js';
import { isPlaceholderEmail } from '../auth/onboarding.js';
import { tokenSessionId } from '../auth/token-session.js';
import { normalizeEmail } from '../auth/users.repository.js';
import {
  accountDevices,
  emailTokens,
  mfaAuthenticators,
  mfaFailures,
  mfaRecoveryCodes,
  oidcLogins,
  passkeys,
  passwordHistory,
  userIdentities,
} from './account.tables.js';

/** The package stores a link by its token's SHA-256, base64url (its `sha256()`). */
const linkId = (token: string) =>
  createHash('sha256').update(token).digest('base64url');

/**
 * The account's queries, beyond UsersRepository (iam/auth) and the
 * package's stores (AccountStores): its `users` row, linked providers,
 * known devices, password history, sessions and token families, and what
 * a link's account is without spending the link. Passkeys have their own
 * (PasskeysRepository). Queries join the current transaction.
 */
@Injectable()
export class AccountRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** The whole row: a mail's recipient (address, name, language, time zone). */
  async find(id: string) {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row;
  }

  /** An account by address, active or not (the magic link mails only an existing one). */
  async findByEmail(email: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)));
    return row;
  }

  /** Changes columns of the account's row; the row as it is then (none: unknown account). */
  async update(id: string, values: Partial<typeof users.$inferInsert>) {
    const [row] = await this.db
      .update(users)
      .set(values)
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  /** The account's password hash (null: none, undefined: no account). */
  async passwordHashOf(id: string) {
    const [row] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, id));
    return row?.passwordHash;
  }

  /** Locks the account's row (`FOR UPDATE`) until the transaction ends. */
  async lock(id: string) {
    await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, id))
      .for('update');
  }

  /**
   * How many ways `userId` has to sign in, counted with the account row
   * locked (`FOR UPDATE`, so call it in a transaction): the password, each
   * linked provider, each passkey. Two removals at once then run one after
   * the other, so neither sees "one left" twice. A magic link isn't
   * counted: it needs nothing on the account and works for everyone.
   */
  async signInMethods(userId: string) {
    const [account] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    const [[{ identities }], [{ credentials }]] = await Promise.all([
      this.db
        .select({ identities: count() })
        .from(userIdentities)
        .where(eq(userIdentities.userId, userId)),
      this.db
        .select({ credentials: count() })
        .from(passkeys)
        .where(eq(passkeys.userId, userId)),
    ]);
    const password = account?.passwordHash ? 1 : 0;
    return {
      password,
      identities,
      passkeys: credentials,
      total: password + identities + credentials,
    };
  }

  /**
   * A new password (a change, a reset link). It also ends the first
   * administrator's password onboarding: the generated password is replaced.
   */
  async replacePassword(id: string, passwordHash: string) {
    await this.db
      .update(users)
      .set({ passwordHash, onboardingPassword: false })
      .where(eq(users.id, id));
  }

  /** Only while `email` is still the user's address: a link sent to an old one verifies nothing. */
  async markEmailVerified(id: string, email: string): Promise<boolean> {
    const rows = await this.db
      .update(users)
      // A real address proved ends the first administrator's email onboarding.
      .set({
        emailVerified: true,
        ...(!isPlaceholderEmail(email) && { onboardingEmail: false }),
      })
      .where(and(eq(users.id, id), eq(users.email, normalizeEmail(email))))
      .returning({ id: users.id });
    return rows.length === 1;
  }

  /**
   * The account a verification link (unspent, unexpired) is for, with what
   * verifying it requires: read without spending the link.
   */
  async pendingVerification(token: string) {
    const [row] = await this.db
      .select({
        userId: users.id,
        passwordHash: users.passwordHash,
        emailVerified: users.emailVerified,
      })
      .from(emailTokens)
      .innerJoin(users, eq(sql`${users.id}::text`, emailTokens.userId))
      .where(
        and(
          eq(emailTokens.id, linkId(token)),
          eq(emailTokens.purpose, 'email-verification'),
          gt(emailTokens.expiresAt, new Date()),
        ),
      );
    return row;
  }

  /** The account a password reset link (unspent, unexpired) is for, without spending it. */
  async pendingReset(token: string) {
    const [row] = await this.db
      .select({ userId: emailTokens.userId })
      .from(emailTokens)
      .where(
        and(
          eq(emailTokens.id, linkId(token)),
          eq(emailTokens.purpose, 'password-reset'),
          gt(emailTokens.expiresAt, new Date()),
        ),
      );
    return row?.userId;
  }

  /** Whether the user was sent a verification link after `since` (a sign-up, a resend). */
  async verificationLinkSentSince(userId: string, since: Date) {
    const [row] = await this.db
      .select({ id: emailTokens.id })
      .from(emailTokens)
      .where(
        and(
          eq(emailTokens.userId, userId),
          eq(emailTokens.purpose, 'email-verification'),
          gt(emailTokens.createdAt, since),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  // Linked providers

  /** The providers connected to the account. */
  identitiesOf(userId: string) {
    return this.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId));
  }

  /** The account an identity of a provider is connected to, and whether it is active. */
  async identityOwner(provider: string, subject: string) {
    const [row] = await this.db
      .select({ userId: userIdentities.userId, active: users.active })
      .from(userIdentities)
      .innerJoin(users, eq(users.id, userIdentities.userId))
      .where(
        and(
          eq(userIdentities.provider, provider),
          eq(userIdentities.subject, subject),
        ),
      );
    return row;
  }

  async hasIdentity(userId: string, provider: string) {
    const [row] = await this.db
      .select({ provider: userIdentities.provider })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.userId, userId),
          eq(userIdentities.provider, provider),
        ),
      );
    return row !== undefined;
  }

  async insertIdentity(values: typeof userIdentities.$inferInsert) {
    await this.db.insert(userIdentities).values(values);
  }

  /** False when the account had no such identity (removed meanwhile). */
  async deleteIdentity(userId: string, provider: string) {
    const deleted = await this.db
      .delete(userIdentities)
      .where(
        and(
          eq(userIdentities.userId, userId),
          eq(userIdentities.provider, provider),
        ),
      )
      .returning();
    return deleted.length > 0;
  }

  // Two-factor

  /** Whether the account's authenticator is confirmed (two-factor on). */
  async mfaConfirmed(userId: string) {
    const [row] = await this.db
      .select({ confirmed: mfaAuthenticators.confirmed })
      .from(mfaAuthenticators)
      .where(eq(mfaAuthenticators.id, userId));
    return row?.confirmed ?? false;
  }

  // Password history

  /** The hashes kept, newest first, at most `limit`. */
  async previousPasswordHashes(userId: string, limit: number) {
    const rows = await this.db
      .select({ passwordHash: passwordHistory.passwordHash })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, userId))
      .orderBy(desc(passwordHistory.createdAt), desc(passwordHistory.id))
      .limit(limit);
    return rows.map((row) => row.passwordHash);
  }

  /** The ids of the hashes kept, newest first. */
  async passwordHistoryIds(userId: string) {
    const rows = await this.db
      .select({ id: passwordHistory.id })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, userId))
      .orderBy(desc(passwordHistory.createdAt), desc(passwordHistory.id));
    return rows.map((row) => row.id);
  }

  async insertPasswordHistory(userId: string, passwordHash: string) {
    await this.db.insert(passwordHistory).values({ userId, passwordHash });
  }

  async deletePasswordHistory(userId: string) {
    await this.db
      .delete(passwordHistory)
      .where(eq(passwordHistory.userId, userId));
  }

  async deletePasswordHistoryIds(ids: string[]) {
    await this.db
      .delete(passwordHistory)
      .where(inArray(passwordHistory.id, ids));
  }

  // Known devices

  /** Whether the account signed in from this device after `since`. */
  async seenDevice(userId: string, device: string, since: Date) {
    const [row] = await this.db
      .select({ lastSeenAt: accountDevices.lastSeenAt })
      .from(accountDevices)
      .where(
        and(
          eq(accountDevices.userId, userId),
          eq(accountDevices.device, device),
          gt(accountDevices.lastSeenAt, since),
        ),
      );
    return row !== undefined;
  }

  /** Whether the account has a known device besides this one. */
  async hasOtherDevice(userId: string, device: string) {
    const [row] = await this.db
      .select({ device: accountDevices.device })
      .from(accountDevices)
      .where(
        and(
          eq(accountDevices.userId, userId),
          ne(accountDevices.device, device),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Whether the account has any known device (it ever signed in). */
  async hasDevice(userId: string) {
    const [row] = await this.db
      .select({ device: accountDevices.device })
      .from(accountDevices)
      .where(eq(accountDevices.userId, userId))
      .limit(1);
    return row !== undefined;
  }

  /** The device seen now, remembered or refreshed. */
  async touchDevice(userId: string, device: string, now: Date) {
    await this.db
      .insert(accountDevices)
      .values({ userId, device, lastSeenAt: now })
      .onConflictDoUpdate({
        target: [accountDevices.userId, accountDevices.device],
        set: { lastSeenAt: now },
      });
  }

  // Sessions and token families

  /** Records that the session's user authenticated at `at`: one atomic merge into its metadata. */
  async stampSession(sessionId: string, at: Date) {
    await this.db
      .update(sessions)
      .set({
        metadata: sql`coalesce(${sessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ authenticatedAt: at.toISOString() })}::jsonb`,
      })
      .where(eq(sessions.id, sessionId));
  }

  /** The user's refresh tokens neither revoked nor past their family's end. */
  liveRefreshTokens(userId: string) {
    return this.db
      .select({
        familyId: refreshTokens.familyId,
        createdAt: refreshTokens.createdAt,
        claims: refreshTokens.claims,
      })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.revoked, false),
          gt(refreshTokens.familyExpiresAt, new Date()),
        ),
      );
  }

  /** The user's unrevoked token families of the session `sid`. */
  async tokenFamiliesOf(userId: string, sid: string) {
    const rows = await this.db
      .selectDistinct({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.revoked, false),
          eq(tokenSessionId, sid),
        ),
      );
    return rows.map((row) => row.familyId);
  }

  // Personal data

  /** Every way back into the account: providers, passkeys, the authenticator and its codes, history, devices, pending links. */
  async eraseSignInMethods(userId: string) {
    await this.db
      .delete(userIdentities)
      .where(eq(userIdentities.userId, userId));
    await this.db.delete(passkeys).where(eq(passkeys.userId, userId));
    await this.db
      .delete(passwordHistory)
      .where(eq(passwordHistory.userId, userId));
    await this.db
      .delete(mfaAuthenticators)
      .where(eq(mfaAuthenticators.id, userId));
    await this.db
      .delete(mfaRecoveryCodes)
      .where(eq(mfaRecoveryCodes.userId, userId));
    await this.db.delete(mfaFailures).where(eq(mfaFailures.userId, userId));
    await this.db
      .delete(accountDevices)
      .where(eq(accountDevices.userId, userId));
    await this.db.delete(emailTokens).where(eq(emailTokens.userId, userId));
    await this.db.delete(oidcLogins).where(eq(oidcLogins.linkUserId, userId));
  }
}
