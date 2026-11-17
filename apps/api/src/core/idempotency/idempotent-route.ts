import { applyDecorators } from '@nestjs/common';
import { Idempotent } from '@nestjs/idempotency';
import { ApiHeader } from '@nestjs/swagger';
import { idempotencyKeyHeader } from './idempotency.openapi.js';

/**
 * `Idempotency-Key` on a write route: a retry gets the first response
 * instead of running the handler again. Unset, the deployment's mode rules
 * (IDEMPOTENCY, and the OpenAPI document follows it); `required` set, the
 * route's own choice wins over the deployment's, in the route and in the document.
 */
export function IdempotentRoute({ required }: { required?: boolean } = {}) {
  return applyDecorators(
    Idempotent(required === undefined ? {} : { required }),
    ApiHeader(idempotencyKeyHeader(required ?? true, required !== undefined)),
  );
}
