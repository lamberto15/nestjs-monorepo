import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  AuthenticationStorage,
  type EmailTokenPurpose,
  type EmailTokenRecord,
  type EmailTokenStore,
  type MagicLinkRecord,
  type MagicLinkStore,
  type MfaStore,
  type OidcStateStore,
  type OidcTransaction,
  type TotpRecord,
} from '@nestjs/authentication';
import { and, desc, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { EncryptedColumns } from '../../core/encryption/encrypted-columns.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import {
  emailTokens,
  magicLinks,
  mfaAuthenticators,
  mfaFailures,
  mfaRecoveryCodes,
  oidcLogins,
} from './account.tables.js';

/** Past this many pending links or logins of a kind, the ones expiring first go. */
const MAX_PENDING = 100_000;

/**
 * The package's stores for two-factor (authenticators, recovery codes,
 * failed attempts), magic links, OIDC logins in progress and email links,
 * in PostgreSQL. Every method that decides whether something works once is
 * a single conditional statement, so the guarantees hold with any number of
 * instances. Queries join the current transaction (`@InjectTransaction()`).
 *
 * The TOTP secrets are encrypted here with the deployment's data keys
 * (core/encryption: key rotation and re-encryption come with it), so the
 * package's own `mfa.encryption` is off (account.options.ts).
 */
@EncryptedColumns([mfaAuthenticators.secret, mfaAuthenticators.pendingSecret])
@Injectable()
export class AccountStores
  implements MfaStore, MagicLinkStore, OidcStateStore, EmailTokenStore
{
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly encryption: EncryptionService,
    storage: AuthenticationStorage,
  ) {
    storage.registerSource({
      mfa: this,
      magicLinks: this,
      oidcStates: this,
      emailTokens: this,
    });
  }

  // Authenticators, recovery codes and failed attempts

  async getTotp(userId: string): Promise<TotpRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(mfaAuthenticators)
      .where(eq(mfaAuthenticators.id, userId));
    if (!row) {
      return undefined;
    }
    return {
      secret: this.encryption.decrypt(mfaAuthenticators.secret, row.secret),
      confirmed: row.confirmed,
      ...(row.pendingSecret !== null && {
        pendingSecret: this.encryption.decrypt(
          mfaAuthenticators.pendingSecret,
          row.pendingSecret,
        ),
      }),
      ...(row.lastUsedStep !== null && { lastUsedStep: row.lastUsedStep }),
    };
  }

  async saveTotp(userId: string, record: TotpRecord | null): Promise<void> {
    if (!record) {
      await this.db
        .delete(mfaAuthenticators)
        .where(eq(mfaAuthenticators.id, userId));
      return;
    }
    const values = {
      secret: this.encryption.encrypt(mfaAuthenticators.secret, record.secret),
      confirmed: record.confirmed,
      pendingSecret: this.encryption.encrypt(
        mfaAuthenticators.pendingSecret,
        record.pendingSecret ?? null,
      ),
    };
    await this.db
      .insert(mfaAuthenticators)
      .values({ id: userId, ...values, lastUsedStep: record.lastUsedStep })
      .onConflictDoUpdate({
        target: mfaAuthenticators.id,
        // Never lower the claimed step: the record may have been read before a claim.
        set: {
          ...values,
          lastUsedStep: sql`greatest(${mfaAuthenticators.lastUsedStep}, excluded.last_used_step)`,
        },
      });
  }

  async claimTotpStep(userId: string, step: number): Promise<boolean> {
    // Conditional: a code's time step is accepted once.
    const claimed = await this.db
      .update(mfaAuthenticators)
      .set({ lastUsedStep: step })
      .where(
        and(
          eq(mfaAuthenticators.id, userId),
          or(
            isNull(mfaAuthenticators.lastUsedStep),
            lt(mfaAuthenticators.lastUsedStep, step),
          ),
        ),
      )
      .returning({ id: mfaAuthenticators.id });
    return claimed.length === 1;
  }

  async saveRecoveryCodes(userId: string, hashes: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(mfaRecoveryCodes)
        .where(eq(mfaRecoveryCodes.userId, userId));
      if (hashes.length > 0) {
        await tx
          .insert(mfaRecoveryCodes)
          .values(
            [...new Set(hashes)].map((codeHash) => ({ userId, codeHash })),
          );
      }
    });
  }

  async consumeRecoveryCode(userId: string, hash: string): Promise<boolean> {
    // Conditional: of two requests with the same code, one deletes the row.
    const consumed = await this.db
      .delete(mfaRecoveryCodes)
      .where(
        and(
          eq(mfaRecoveryCodes.userId, userId),
          eq(mfaRecoveryCodes.codeHash, hash),
        ),
      )
      .returning({ userId: mfaRecoveryCodes.userId });
    return consumed.length === 1;
  }

  countRecoveryCodes(userId: string): Promise<number> {
    return this.db.$count(
      mfaRecoveryCodes,
      eq(mfaRecoveryCodes.userId, userId),
    );
  }

  async recordMfaFailure(
    userId: string,
    windowMs: number,
    now: number,
  ): Promise<number> {
    // Insert, then count, each committed on its own outside a transaction:
    // every attempt counts itself and all those recorded before it.
    await this.db
      .insert(mfaFailures)
      .values({ userId, failedAt: new Date(now) });
    const failures = await this.countMfaFailures(userId, windowMs, now);
    await this.db
      .delete(mfaFailures)
      .where(lte(mfaFailures.failedAt, new Date(now - windowMs)));
    return failures;
  }

  countMfaFailures(
    userId: string,
    windowMs: number,
    now: number,
  ): Promise<number> {
    return this.db.$count(
      mfaFailures,
      and(
        eq(mfaFailures.userId, userId),
        gt(mfaFailures.failedAt, new Date(now - windowMs)),
      ),
    );
  }

  async clearMfaFailures(userId: string): Promise<void> {
    await this.db.delete(mfaFailures).where(eq(mfaFailures.userId, userId));
  }

  // Magic links

  async saveMagicLink(record: MagicLinkRecord): Promise<void> {
    await this.db.insert(magicLinks).values(record);
    await this.trim(magicLinks, record.createdAt);
  }

  async consumeMagicLink(id: string): Promise<MagicLinkRecord | undefined> {
    // DELETE … RETURNING: of two requests with the same link, one gets the row.
    const [row] = await this.db
      .delete(magicLinks)
      .where(eq(magicLinks.id, id))
      .returning();
    return row && withoutNulls(row);
  }

  // OIDC logins in progress

  async saveOidcState({ link, ...login }: OidcTransaction): Promise<void> {
    await this.db.insert(oidcLogins).values({
      ...login,
      linkUserId: link?.userId,
      linkSessionId: link?.sessionId,
    });
    await this.trim(oidcLogins, login.createdAt);
  }

  async consumeOidcState(state: string): Promise<OidcTransaction | undefined> {
    const [row] = await this.db
      .delete(oidcLogins)
      .where(eq(oidcLogins.state, state))
      .returning();
    if (!row) {
      return undefined;
    }
    const { linkUserId, linkSessionId, ...login } = withoutNulls(row);
    return linkUserId && linkSessionId
      ? { ...login, link: { userId: linkUserId, sessionId: linkSessionId } }
      : login;
  }

  // Password reset and email verification links

  async saveEmailToken(record: EmailTokenRecord): Promise<void> {
    await this.db.insert(emailTokens).values(record);
    await this.trim(emailTokens, record.createdAt);
  }

  async consumeEmailToken(
    id: string,
    purpose: EmailTokenPurpose,
  ): Promise<EmailTokenRecord | undefined> {
    const [row] = await this.db
      .delete(emailTokens)
      .where(and(eq(emailTokens.id, id), eq(emailTokens.purpose, purpose)))
      .returning();
    return row && withoutNulls(row);
  }

  async deleteUserEmailTokens(
    userId: string,
    purpose: EmailTokenPurpose,
  ): Promise<void> {
    await this.db
      .delete(emailTokens)
      .where(
        and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose)),
      );
  }

  /** Deletes what expired, and past MAX_PENDING, what expires first. */
  private async trim(
    table: typeof magicLinks | typeof oidcLogins | typeof emailTokens,
    now: Date,
  ) {
    await this.db.delete(table).where(lte(table.expiresAt, now));
    const [cutoff] = await this.db
      .select({ expiresAt: table.expiresAt })
      .from(table)
      .orderBy(desc(table.expiresAt))
      .limit(1)
      .offset(MAX_PENDING);
    if (cutoff) {
      await this.db.delete(table).where(lte(table.expiresAt, cutoff.expiresAt));
    }
  }
}

/** A row without its NULL columns: the package's records leave optional fields out. */
type WithoutNulls<T> = {
  [K in keyof T as null extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as null extends T[K] ? K : never]?: Exclude<T[K], null>;
};

function withoutNulls<T extends object>(row: T): WithoutNulls<T> {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== null),
  ) as WithoutNulls<T>;
}
