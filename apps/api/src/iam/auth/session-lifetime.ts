import { Injectable } from '@nestjs/common';
import { RefreshTokenError, type SessionRecord } from '@nestjs/authentication';
import { createHash } from 'node:crypto';
import { AuthPolicy } from './auth-policy.js';
import { DrizzleAuthenticationStore } from './drizzle-authentication.store.js';
import { impersonationOf } from './impersonation.js';

/** The access tokens' lifetime (auth.module.ts): they outlive a revoked family by this much. */
export const ACCESS_TOKEN_TTL_MS = 15 * 60_000;

/**
 * A tenant's session policy (AuthPolicySource's `sessionIdleMinutes`,
 * `sessionMaxHours`) on top of the
 * environment's, which the package enforces itself (`session.idleTtl`,
 * `session.absoluteTtl`): the environment is the ceiling, so this only ever
 * ends a session or a token family sooner. Custom code: the package takes
 * one lifetime for the whole deployment, no per-tenant one.
 */
@Injectable()
export class SessionLifetime {
  constructor(
    private readonly policy: AuthPolicy,
    private readonly store: DrizzleAuthenticationStore,
  ) {}

  /**
   * Whether a browser session has outlived its tenant's limits: older than
   * the tenant's maximum since its sign-in, or idle for longer than its
   * idle timeout before this request (`previousActiveAt`, the
   * activity as stored before it moved).
   */
  async expired(
    session: SessionRecord,
    tenantId: string | null | undefined,
    now = Date.now(),
  ) {
    const { idleMs, maxMs } = await this.policy.sessionLimits(tenantId);
    const previous = session.extra?.previousActiveAt ?? session.lastActiveAt;
    return (
      now >= session.createdAt.getTime() + maxMs ||
      now >= previous.getTime() + idleMs
    );
  }

  /**
   * What a "who am I" route tells a browser session about its lifetime
   * (the web app warns before the idle timeout), or null for a token, an
   * impersonation or anything that is not a stored session.
   */
  async describe(
    session: unknown,
    user: { tenantId?: string | null; impersonator?: unknown },
  ) {
    const record = session as Partial<SessionRecord> | null | undefined;
    if (
      user.impersonator ||
      !(record?.createdAt instanceof Date) ||
      !(record.expiresAt instanceof Date) ||
      !(record.lastActiveAt instanceof Date)
    ) {
      return null;
    }
    const { idleMs, maxMs } = await this.policy.sessionLimits(user.tenantId);
    return {
      idleMinutes: Math.round(idleMs / 60_000),
      lastActiveAt: record.lastActiveAt.toISOString(),
      expiresAt: new Date(
        Math.min(
          record.expiresAt.getTime(),
          record.createdAt.getTime() + maxMs,
        ),
      ).toISOString(),
    };
  }

  /**
   * When a stored session ends unless a request uses it again (epoch ms):
   * a session at its idle timeout or maximum age as describe() gives them;
   * an impersonation, which the tenant's limits don't bind (SessionAuth),
   * at the environment's (the package's) or its own end, whichever comes
   * first. Null for what is not a stored session. A realtime socket ends
   * then, unless SessionAuth.revalidate() still accepts the session.
   */
  async endsAt(
    session: SessionRecord,
    user: { tenantId?: string | null; impersonator?: unknown },
  ) {
    const impersonation = impersonationOf(session);
    if (!impersonation) {
      const life = await this.describe(session, user);
      return life
        ? Math.min(
            Date.parse(life.expiresAt),
            Date.parse(life.lastActiveAt) + life.idleMinutes * 60_000,
          )
        : null;
    }
    const { idleMs } = await this.policy.sessionLimits(null);
    return Math.min(
      session.expiresAt.getTime(),
      session.lastActiveAt.getTime() + idleMs,
      Date.parse(impersonation.endsAt),
    );
  }

  /**
   * Refuses (401, as an expired refresh token) a refresh whose family has
   * outlived its tenant's limits, and revokes it. Only what the tenant chose
   * applies: a family has its own lifetime (90 days) and no idle timeout
   * unless the tenant restricted them. Idle is counted from the last
   * refresh, with the access token's lifetime on top (a client working on
   * its access token has not refreshed yet).
   */
  async assertRefreshable(refreshToken: string, now = Date.now()) {
    const id = createHash('sha256').update(refreshToken).digest('base64url');
    const token = await this.store.getRefreshToken(id);
    if (!token) {
      return;
    }
    const tid = token.claims?.tid;
    const { chosen } = await this.policy.sessionLimits(
      typeof tid === 'string' ? tid : undefined,
    );
    if (chosen.idleMs === undefined && chosen.maxMs === undefined) {
      return;
    }
    const bounds = await this.store.refreshTokenFamilyBounds(token.familyId);
    if (!bounds) {
      return;
    }
    if (
      (chosen.maxMs !== undefined &&
        now >= bounds.first.getTime() + chosen.maxMs) ||
      (chosen.idleMs !== undefined &&
        now >= bounds.last.getTime() + chosen.idleMs + ACCESS_TOKEN_TTL_MS)
    ) {
      await this.store.revokeRefreshTokenFamily(token.familyId);
      throw new RefreshTokenError('expired');
    }
  }
}
