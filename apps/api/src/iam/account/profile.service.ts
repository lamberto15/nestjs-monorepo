import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { users } from '../auth/auth.tables.js';
import type { UserPrincipal } from '../auth/principal.js';
import { AccountWork } from './account-work.js';

export interface ProfileChanges {
  name?: string;
  /** null: back to the request's language. */
  locale?: string | null;
  /** null: back to the app's time zone. */
  timezone?: string | null;
}

/** The person's own name, language and time zone (the account's, in no tenant). */
@Injectable()
export class ProfileService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly work: AccountWork,
  ) {}

  async update(user: UserPrincipal, changes: ProfileChanges) {
    const set = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined),
    ) as ProfileChanges;
    const [row] = await this.work.run(() =>
      Object.keys(set).length
        ? this.db
            .update(users)
            .set(set)
            .where(eq(users.id, user.id))
            .returning()
        : this.db.select().from(users).where(eq(users.id, user.id)),
    );
    return {
      kind: 'user' as const,
      id: row!.id,
      email: row!.email,
      name: row!.name,
      emailVerified: row!.emailVerified,
      locale: row!.locale,
      timezone: row!.timezone,
      tenantId: user.tenantId,
    };
  }
}
