import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  AuthenticationStorage,
  type RefreshTokenRecord,
  type RefreshTokenStore,
  type SessionRecord,
  type SessionStore,
} from '@nestjs/authentication';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq, isNull, lt, lte, max, min, or } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  AUTH_EVENTS,
  type SessionEndedEvent,
  type TokenSessionEndedEvent,
} from './auth.events.js';
import { impersonatorOf, refreshTokens, sessions } from './auth.tables.js';
import { distinctTokenSessionIds, tokenSessionId } from './token-session.js';
import { UsersRepository } from './users.repository.js';

/**
 * Keeps browser sessions and refresh tokens in PostgreSQL, through Drizzle.
 * Every method that decides whether something works once is a single
 * conditional statement, so the guarantees hold with any number of API
 * instances. The stores of the other features (two-factor, magic links,
 * OIDC, email links) register as their own sources from their modules
 * (`AuthenticationStorage.registerSource()` takes parts).
 *
 * Queries join the current transaction (`@InjectTransaction()`); outside
 * one each statement commits by itself, as the package expects. What ends
 * a session or a token family is announced (`auth.session-ended`,
 * `auth.token-session-ended`) for the sockets it opened.
 */
const ownedOrImpersonatedBy = (userId: string) =>
  or(
    eq(sessions.userId, userId),
    eq(impersonatorOf(sessions.metadata), userId),
  );

@Injectable()
export class DrizzleAuthenticationStore
  implements SessionStore, RefreshTokenStore
{
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly users: UsersRepository,
    private readonly events: EventEmitter2,
    storage: AuthenticationStorage,
  ) {
    storage.registerSource({ sessions: this, refreshTokens: this });
  }

  // Sessions

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id));
    return (
      row && {
        ...withoutNulls(row),
        // Before SessionService moves it forward (touchSession): a tenant's
        // idle timeout is judged on the activity before this request.
        extra: { previousActiveAt: row.lastActiveAt },
      }
    );
  }

  // Every new session (a sign-in by any method; a rotation copies its
  // metadata) acts in a tenant: the user's last chosen, else the oldest
  // membership, unless the caller named one (a switch, an impersonation)
  // or none (null).
  async createSession(record: SessionRecord): Promise<void> {
    if (record.metadata?.tenantId === undefined) {
      // In place: the caller's record (the issued session) shows it too.
      record.metadata = {
        ...record.metadata,
        tenantId: await this.users.defaultTenant(record.userId),
      };
    }
    await this.db.insert(sessions).values(record);
    await this.db
      .delete(sessions)
      .where(lte(sessions.expiresAt, record.createdAt));
  }

  async touchSession(id: string, lastActiveAt: Date): Promise<void> {
    // Conditional: a session deleted by a sign-out stays deleted.
    await this.db
      .update(sessions)
      .set({ lastActiveAt })
      .where(and(eq(sessions.id, id), lt(sessions.lastActiveAt, lastActiveAt)));
  }

  // Whether this call deleted it: of two rotations of a session, or a rotation and a sign-out, one wins.
  async deleteSession(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(sessions)
      .where(eq(sessions.id, id))
      .returning({ id: sessions.id });
    await this.sessionsEnded(deleted);
    return deleted.length > 0;
  }

  /**
   * The user's sessions, and those in which they act as someone else
   * (impersonation: stored under the member's id). `revokeAll()` lists and
   * deletes through these two, so signing out everywhere, a password change
   * or reset end an administrator's impersonations too; left running, one
   * would hand a fresh administrator session back when it stops.
   */
  async listUserSessions(userId: string): Promise<SessionRecord[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(ownedOrImpersonatedBy(userId));
    return rows.map(withoutNulls);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    const deleted = await this.db
      .delete(sessions)
      .where(ownedOrImpersonatedBy(userId))
      .returning({ id: sessions.id });
    await this.sessionsEnded(deleted);
  }

  // Refresh tokens

  async getRefreshToken(id: string): Promise<RefreshTokenRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.id, id));
    if (!row) {
      return undefined;
    }
    const { revoked: _, ...token } = row;
    return withoutNulls(token);
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    await this.db.insert(refreshTokens).values(record);
    await this.db
      .delete(refreshTokens)
      .where(lte(refreshTokens.familyExpiresAt, record.createdAt));
  }

  /**
   * When the family's first token was made (its sign-in) and its latest
   * (its last refresh): what a tenant's session limits are judged on
   * (SessionLifetime). Undefined: no such family.
   */
  async refreshTokenFamilyBounds(familyId: string) {
    const [row] = await this.db
      .select({
        first: min(refreshTokens.createdAt),
        last: max(refreshTokens.createdAt),
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, familyId));
    return row?.first && row.last
      ? { first: row.first, last: row.last }
      : undefined;
  }

  async markRefreshTokenUsed(id: string, at: Date): Promise<boolean> {
    // Conditional: of two refreshes with the same token, one updates the row.
    const updated = await this.db
      .update(refreshTokens)
      .set({ usedAt: at })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.usedAt)))
      .returning({ id: refreshTokens.id });
    return updated.length === 1;
  }

  async revokeRefreshTokenFamily(familyId: string): Promise<void> {
    const revoked = await this.db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.familyId, familyId))
      .returning({ sid: tokenSessionId });
    await this.tokenSessionsEnded(revoked);
  }

  async isRefreshTokenFamilyRevoked(familyId: string): Promise<boolean> {
    const revoked = await this.db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.familyId, familyId),
          eq(refreshTokens.revoked, true),
        ),
      )
      .limit(1);
    return revoked.length > 0;
  }

  async revokeUserRefreshTokens(userId: string): Promise<void> {
    // The families still live: those revoked before have nothing left to end.
    const revoked = await this.db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(
        and(eq(refreshTokens.userId, userId), eq(refreshTokens.revoked, false)),
      )
      .returning({ sid: tokenSessionId });
    await this.tokenSessionsEnded(revoked);
  }

  /**
   * Whether the family whose access tokens carry this `sid` (tokenClaims())
   * was revoked. Not the package's: its access tokens live until they
   * expire, and requests don't ask. A realtime handshake does, since a
   * socket outlives the access token that opened it.
   */
  async isTokenSessionRevoked(userId: string, sid: string): Promise<boolean> {
    const revoked = await this.db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.revoked, true),
          eq(tokenSessionId, sid),
        ),
      )
      .limit(1);
    return revoked.length > 0;
  }

  private async sessionsEnded(rows: { id: string }[]) {
    for (const { id } of rows) {
      await this.events.emitAsync(AUTH_EVENTS.sessionEnded, {
        sessionId: id,
      } satisfies SessionEndedEvent);
    }
  }

  /** Each family's `sid` once (a family has a row per rotation). */
  private async tokenSessionsEnded(rows: { sid: string | null }[]) {
    for (const sid of distinctTokenSessionIds(rows)) {
      await this.events.emitAsync(AUTH_EVENTS.tokenSessionEnded, {
        sid,
      } satisfies TokenSessionEndedEvent);
    }
  }
}

/** A row without its NULL columns: the package's records leave optional fields out. */
export type WithoutNulls<T> = {
  [K in keyof T as null extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as null extends T[K] ? K : never]?: Exclude<T[K], null>;
};

export function withoutNulls<T extends object>(row: T): WithoutNulls<T> {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== null),
  ) as WithoutNulls<T>;
}
