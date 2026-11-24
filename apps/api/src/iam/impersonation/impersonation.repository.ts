import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { roles, userRoles } from '../access/access.tables.js';
import { liveGrant } from '../access/roles.service.js';

/** The queries of impersonation, in the request's tenant and the ambient transaction. */
@Injectable()
export class ImpersonationRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** Whether the user holds a system role (the built-in Administrator) by a grant still running. */
  async holdsSystemRole(userId: string) {
    const [row] = await this.db
      .select({ roleId: roles.id })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(
        and(
          eq(userRoles.userId, userId),
          eq(roles.system, true),
          liveGrant(userRoles),
        ),
      )
      .limit(1);
    return !!row;
  }
}
