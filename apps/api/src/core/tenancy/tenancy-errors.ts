import { ForbiddenException } from '@nestjs/common';
import { ProblemDetailsFilter } from '../http/problem-details.filter.js';
import { TenantScopeMissingError } from './tenant-scope.js';

/**
 * Work on a tenant's data without a tenant, over HTTP: 403
 * `tenant_required` rather than a 500 (the caller has none). Drizzle wraps
 * an insert's refusal (the error in `cause`), so the chain is searched.
 */
ProblemDetailsFilter.map(Error, (error) => {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (e instanceof TenantScopeMissingError) {
      return new ForbiddenException(
        { code: 'tenant_required', message: 'This needs a tenant.' },
        { cause: error },
      );
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
});
