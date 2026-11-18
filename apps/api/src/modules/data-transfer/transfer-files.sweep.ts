import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { StorageDisk } from '@nestjs/storage';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { transferKey } from './data-transfer.service.js';
import { deleteUnkept } from './transfer-retention.js';

/**
 * Deletes the files of transfers no longer kept (TRANSFER_KEPT_MS): every
 * tenant's `tenants/<id>/transfers/` (exports, import reports, uploads an
 * import never got to), every night at 04:35 UTC on one instance. The disk
 * lists them with their age; nothing in the database names them, so no
 * tenant scope is needed beyond walking the tenants (deactivated ones too).
 */
@Injectable()
export class TransferFilesSweep {
  private readonly logger = new Logger('DataTransfer');

  constructor(
    private readonly disk: StorageDisk,
    private readonly tenancy: Tenancy,
  ) {}

  /** Returns how many files were deleted. */
  @Cron('35 4 * * *', { name: 'data-transfer-files', timeZone: 'UTC' })
  @OnOneInstance({ key: 'data-transfer:files' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const swept = await this.tenancy.forEachTenant(
      'data-transfer-files',
      (tenant) => deleteUnkept(this.disk, transferKey(tenant.id, ''), now),
      { includeInactive: true },
    );
    const deleted = [...swept.values()].reduce((sum, count) => sum + count, 0);
    this.logger.log(`Expired transfer files deleted: ${deleted}`);
    return deleted;
  }
}
