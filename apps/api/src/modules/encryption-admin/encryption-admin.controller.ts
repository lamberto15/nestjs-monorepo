import { Controller, Get, HttpCode, Ip, Post } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { OperatorOnly } from '../../iam/auth/operator-only.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { EncryptionAdminPolicy } from './encryption-admin.policy.js';
import {
  encryptionStatusSchema,
  reencryptionQueuedSchema,
} from './encryption-admin.schemas.js';
import { EncryptionAdminService } from './encryption-admin.service.js';

/**
 * The state of the encryption keys and the re-encryption job, for the
 * operators (`@OperatorOnly()`, `Access.manageEncryption`): after adding a
 * key in front of DATA_ENCRYPTION_KEYS, the old one may leave once
 * `upToDate` is true. Key ids only, never a key.
 */
@ApiTags('encryption')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session.' })
@ApiForbiddenResponse({
  description: 'Not an operator, or not allowed by your permissions.',
})
@UserOnly()
@OperatorOnly()
@AllowInMaintenance()
@Controller('encryption')
export class EncryptionAdminController {
  constructor(
    private readonly admin: EncryptionAdminService,
    private readonly audit: AuditService,
  ) {}

  @Get('status')
  @Can(EncryptionAdminPolicy, 'manageEncryption')
  @ApiOperation({
    summary:
      'The current key ids and the rows still on an older key, per encrypted column',
    description:
      "Counts every tenant's rows, so it reads each tenant in turn: not for a dashboard's polling.",
  })
  @ApiOkResponse({ standardSchema: encryptionStatusSchema })
  status() {
    return this.admin.status();
  }

  @Post('reencryption')
  @Can(EncryptionAdminPolicy, 'manageEncryption')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Queue the re-encryption of the rows on an old key now',
    description:
      'The hourly schedule does the same: this is for not waiting. One job per tenant with stale rows; idempotent. Audited.',
  })
  @ApiOkResponse({ standardSchema: reencryptionQueuedSchema })
  async reencrypt(@CurrentUser() user: UserPrincipal, @Ip() ip: string) {
    const queued = await this.admin.schedule();
    await this.audit.record(user, {
      action: 'encryption.reencryption-queued',
      details: { queued },
      ip,
    });
    return { queued };
  }
}
