import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { DrizzleAuthenticationStore } from './drizzle-authentication.store.js';

/**
 * Deletes expired sessions and refresh-token families every hour at :25
 * UTC, on one instance. A sign-in and a saved refresh token used to do it
 * each time, a delete over the whole table on every one.
 */
@Injectable()
export class SessionPruneJob {
  private readonly logger = new Logger('Sessions');

  constructor(
    private readonly store: DrizzleAuthenticationStore,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('25 * * * *', { name: 'session-prune', timeZone: 'UTC' })
  @OnOneInstance({ key: 'iam:session-prune' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    // Global tables (every tenant's sign-ins together): no tenant.
    const deleted = await this.tenancy.run(null, () =>
      this.store.pruneExpired(now),
    );
    if (deleted > 0) this.logger.log('Expired sessions deleted', { deleted });
    return deleted;
  }
}
