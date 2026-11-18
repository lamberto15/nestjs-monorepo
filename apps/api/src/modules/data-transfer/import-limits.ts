import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Principal } from '../../iam/auth/principal.js';
import { SettingsService } from '../settings/settings.service.js';
import { dataTransferConfig } from './data-transfer.config.js';
import { IMPORT_MAX_MIB, IMPORT_MAX_ROWS } from './data-transfer.settings.js';
import type { ImportLimits as Limits } from './data-transfer.types.js';

const MIB = 1024 * 1024;

/**
 * An import's limits (docs: README.md, "Import limits"): the tenant's
 * settings, never above the deployment's ceilings (IMPORT_MAX_BYTES,
 * IMPORT_MAX_ROWS). A higher setting is refused when set (400
 * `setting_not_allowed`); one stored before the ceiling was lowered is
 * capped when read.
 */
@Injectable()
export class ImportLimits implements OnModuleInit {
  constructor(
    private readonly settings: SettingsService,
    @Inject(dataTransferConfig.KEY)
    private readonly config: ConfigType<typeof dataTransferConfig>,
  ) {}

  onModuleInit() {
    this.settings.restrict(IMPORT_MAX_MIB, (value) =>
      value * MIB > this.config.maxBytes
        ? `IMPORT_MAX_BYTES is ${this.config.maxBytes} in this deployment: the import size limit may only lower it.`
        : undefined,
    );
    this.settings.restrict(IMPORT_MAX_ROWS, (value) =>
      value > this.config.maxRows
        ? `IMPORT_MAX_ROWS is ${this.config.maxRows} in this deployment: the import row limit may only lower it.`
        : undefined,
    );
  }

  /** Resolved once for an upload: the job keeps them, so a later change affects new uploads only. */
  async for(principal: Principal): Promise<Limits> {
    const [size, rows] = await Promise.all([
      this.settings.resolve(IMPORT_MAX_MIB, principal),
      this.settings.resolve(IMPORT_MAX_ROWS, principal),
    ]);
    return {
      maxBytes:
        size.source === 'default'
          ? this.config.maxBytes
          : Math.min(size.value * MIB, this.config.maxBytes),
      maxRows:
        rows.source === 'default'
          ? this.config.maxRows
          : Math.min(rows.value, this.config.maxRows),
    };
  }
}
