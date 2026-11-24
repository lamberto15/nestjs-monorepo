import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../../core/database/database.js';
import { memberships } from '../../../iam/auth/auth.tables.js';
import { userAvatars } from './avatars.tables.js';

/** The users' pictures' queries, in the caller's transaction. */
@Injectable()
export class AvatarsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async find(userId: string) {
    const [row] = await this.db
      .select()
      .from(userAvatars)
      .where(eq(userAvatars.userId, userId));
    return row;
  }

  /** The user's picture key, when they are a member of the tenant. */
  async keyOfMember(userId: string, tenantId: string) {
    const [row] = await this.db
      .select({ key: userAvatars.key })
      .from(userAvatars)
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, userAvatars.userId),
          eq(memberships.tenantId, tenantId),
        ),
      )
      .where(eq(userAvatars.userId, userId));
    return row?.key;
  }

  /** The user's picture key, locked until the transaction ends. */
  async lockKey(userId: string) {
    const [row] = await this.db
      .select({ key: userAvatars.key })
      .from(userAvatars)
      .where(eq(userAvatars.userId, userId))
      .for('update');
    return row?.key;
  }

  async save(userId: string, key: string) {
    await this.db
      .insert(userAvatars)
      .values({ userId, key })
      .onConflictDoUpdate({ target: userAvatars.userId, set: { key } });
  }

  async delete(userId: string) {
    await this.db.delete(userAvatars).where(eq(userAvatars.userId, userId));
  }

  async ofUsers(userIds: readonly string[]) {
    return this.db
      .select({ userId: userAvatars.userId, key: userAvatars.key })
      .from(userAvatars)
      .where(inArray(userAvatars.userId, [...userIds]));
  }
}
