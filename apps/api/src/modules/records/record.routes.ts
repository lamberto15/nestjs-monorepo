import {
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  applyDecorators,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can } from '@nestjs/authorization';
import {
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { Etag } from '../../core/http/etag.js';
import { IdempotentRoute } from '../../core/idempotency/idempotent-route.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal, RequestPrincipal } from '../../iam/auth/principal.js';
import { aNoun, type RecordDeclaration } from './record.js';
import { RecordController } from './record-extension.js';
import { RecordPresenter } from './record.presenter.js';
import type { RecordSchemas } from './record.schemas.js';
import { RecordStore } from './record.store.js';
import { RecordFeature } from './records.service.js';

/**
 * `Idempotency-Key` on a record's create, as the declaration says
 * (`idempotency`): unset, the deployment's mode; `required` or `optional`,
 * the feature's own choice; `off`, none.
 */
export function RecordIdempotent(declaration: RecordDeclaration) {
  if (declaration.idempotency === 'off') return applyDecorators();
  return IdempotentRoute(
    declaration.idempotency === undefined
      ? {}
      : { required: declaration.idempotency === 'required' },
  );
}

/** The delete route's text: to the recycle bin, or for good. */
export const deleteDocs = (declaration: RecordDeclaration) =>
  declaration.softDelete
    ? {
        summary: `Delete ${aNoun(declaration)} (to the recycle bin)`,
        description: `POST /v1/${declaration.path}/{id}/restore brings it back.`,
      }
    : { summary: `Delete ${aNoun(declaration)}` };

/**
 * Field-level permissions on a write: a 403 `field_forbidden` naming the
 * fields of the body the caller may not set (on this record, for an update).
 */
export async function assertWritableFields(
  access: AccessService,
  user: Principal,
  action: 'create' | 'update',
  declaration: RecordDeclaration,
  body: object,
  row?: Record<string, unknown>,
) {
  const forbidden = await access.forbiddenFields(
    user,
    action,
    declaration.subject,
    body as Record<string, unknown>,
    row,
  );
  if (forbidden.length > 0) {
    throw new ForbiddenException({
      code: 'field_forbidden',
      message: `You may not set: ${forbidden.join(', ')}.`,
      fields: forbidden,
    });
  }
}

/**
 * `POST /<path>/{id}/restore`: a record out of the recycle bin. Mounted by
 * RecordsModule.forFeature() when the declaration says `softDelete`; the
 * policy's `restore` decides who may; one the caller may not restore is
 * the 404 of a missing one.
 */
export function restoreController(
  declaration: RecordDeclaration,
  schemas: RecordSchemas,
): Type {
  @RecordController(declaration, '', 'Restore')
  class RestoreRoutes {
    constructor(
      private readonly feature: RecordFeature,
      private readonly store: RecordStore,
      private readonly presenter: RecordPresenter,
      private readonly authorization: AuthorizationService,
    ) {}

    @Post(':id/restore')
    @HttpCode(HttpStatus.OK)
    @Etag()
    @Can.Anyone() // Checked below, on the record itself.
    @ApiOperation({
      summary: `Restore ${aNoun(declaration)} from the recycle bin`,
    })
    @ApiOkResponse({ standardSchema: schemas.response })
    @ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
    @ApiNotFoundResponse({ description: 'Not in the recycle bin.' })
    async restore(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
    ) {
      const row = await this.store.findOne(id, {
        deleted: true,
        visibleTo: user,
      });
      await this.authorization.authorize(
        this.feature.policy as unknown as Type<{
          restore(...args: unknown[]): boolean;
        }>,
        'restore',
        user,
        row,
      );
      return this.presenter.one(user, await this.store.restore(user, id));
    }
  }
  return RestoreRoutes;
}
