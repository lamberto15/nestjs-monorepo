import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { ssoAssertions, ssoRequests } from './sso.tables.js';

/**
 * The queries of the sign-ins under way (`sso_requests`) and the SAML
 * assertions already used (`sso_assertions`), in the request's tenant and
 * the ambient transaction (`@InjectTransaction()`).
 */
@Injectable()
export class SsoRequestsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async deleteExpired(now: Date) {
    await this.db.delete(ssoRequests).where(lt(ssoRequests.expiresAt, now));
  }

  async insert(values: typeof ssoRequests.$inferInsert) {
    const [row] = await this.db
      .insert(ssoRequests)
      .values(values)
      .returning({ id: ssoRequests.id });
    return row!;
  }

  async setSamlRequestId(id: string, samlRequestId: string) {
    await this.db
      .update(ssoRequests)
      .set({ samlRequestId })
      .where(eq(ssoRequests.id, id));
  }

  /** A SAML request of this browser's, unused, not handed over and unexpired. */
  async findOpenSaml(
    connectionId: string,
    samlRequestId: string,
    bindingHash: string,
    now: Date,
  ) {
    const [row] = await this.db
      .select({ createdAt: ssoRequests.createdAt })
      .from(ssoRequests)
      .where(
        and(
          eq(ssoRequests.connectionId, connectionId),
          eq(ssoRequests.samlRequestId, samlRequestId),
          eq(ssoRequests.bindingHash, bindingHash),
          isNull(ssoRequests.consumedAt),
          isNull(ssoRequests.userId),
          gt(ssoRequests.expiresAt, now),
        ),
      );
    return row;
  }

  async findSaml(
    connectionId: string,
    samlRequestId: string,
    bindingHash: string,
  ) {
    const [row] = await this.db
      .select({ id: ssoRequests.id, redirectTo: ssoRequests.redirectTo })
      .from(ssoRequests)
      .where(
        and(
          eq(ssoRequests.connectionId, connectionId),
          eq(ssoRequests.samlRequestId, samlRequestId),
          eq(ssoRequests.bindingHash, bindingHash),
        ),
      );
    return row;
  }

  /** Gives a request not yet handed over nor used its account; undefined when it was. */
  async handOver(
    id: string,
    values: { userId: string; authenticatedAt: Date | null; expiresAt: Date },
  ) {
    const [row] = await this.db
      .update(ssoRequests)
      .set(values)
      .where(
        and(
          eq(ssoRequests.id, id),
          isNull(ssoRequests.userId),
          isNull(ssoRequests.consumedAt),
        ),
      )
      .returning({ id: ssoRequests.id });
    return row;
  }

  /**
   * Marks used the unused, unexpired request of this browser (and, for the
   * code flow, not a SAML one), and returns it; undefined when there is none.
   */
  async take(
    connectionId: string,
    bindingHash: string,
    options: { codeFlow: boolean },
  ) {
    const now = new Date();
    const [row] = await this.db
      .update(ssoRequests)
      .set({ consumedAt: now })
      .where(
        and(
          eq(ssoRequests.connectionId, connectionId),
          eq(ssoRequests.bindingHash, bindingHash),
          isNull(ssoRequests.consumedAt),
          options.codeFlow ? isNull(ssoRequests.samlRequestId) : undefined,
          gt(ssoRequests.expiresAt, now),
        ),
      )
      .returning();
    return row;
  }

  async deleteExpiredAssertions(now: Date) {
    await this.db.delete(ssoAssertions).where(lt(ssoAssertions.expiresAt, now));
  }

  /** Records an assertion as used; undefined when it was already. */
  async insertAssertion(values: {
    connectionId: string;
    assertionId: string;
    expiresAt: Date;
  }) {
    const [row] = await this.db
      .insert(ssoAssertions)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: ssoAssertions.assertionId });
    return row;
  }
}
