import { Policy } from '@nestjs/authorization';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/** Who reads the findings, starts scans and resolves findings (DataQuality.read|scan|resolve). */
@Policy()
export class DataQualityPolicy {
  constructor(private readonly access: AccessService) {}

  read(user: Principal | null) {
    return this.access.can(user, 'read', 'DataQuality');
  }

  scan(user: Principal | null) {
    return this.access.can(user, 'scan', 'DataQuality');
  }

  resolve(user: Principal | null) {
    return this.access.can(user, 'resolve', 'DataQuality');
  }
}
