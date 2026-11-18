import { Injectable } from '@nestjs/common';
import { ClientQuota } from '../../iam/api-clients/client-quota.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { UsagePolicy } from './usage.policy.js';
import { UsageService } from './usage.service.js';

/** A new API client's quota, set with its create (iam/api-clients finds this by `@ClientQuota()`). */
@ClientQuota()
@Injectable()
export class UsageClientQuota implements ClientQuota {
  constructor(
    private readonly policy: UsagePolicy,
    private readonly usage: UsageService,
  ) {}

  allowed(actor: UserPrincipal) {
    return this.policy.setClientQuota(actor);
  }

  set(actor: UserPrincipal, clientId: string, dailyQuota: number, ip?: string) {
    return this.usage.setQuota(actor, clientId, dailyQuota, ip);
  }
}
