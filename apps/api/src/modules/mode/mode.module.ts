import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { APP_GUARD } from '@nestjs/core';
import { queuesConfig } from '../../core/queues/queues.config.js';
import { SettingsModule } from '../settings/settings.module.js';
import { modeConfig } from './mode.config.js';
import { ModeFeature } from './mode.feature.js';
import { ModeGuard } from './mode.guard.js';
import { ModeService } from './mode.service.js';
import { MODE_SETTINGS } from './mode.setting.js';

/**
 * `platform.mode` / `APP_MODE`: read-only and maintenance (README.md). The
 * guard is global (APP_GUARD): import this module once, in `app.module.ts`.
 */
@Module({
  imports: [
    ConfigModule.forFeature(modeConfig),
    ConfigModule.forFeature(queuesConfig),
    DiscoveryModule,
    SettingsModule.forFeature(MODE_SETTINGS),
  ],
  providers: [
    ModeService,
    ModeFeature,
    { provide: APP_GUARD, useClass: ModeGuard },
  ],
  exports: [ModeService],
})
export class ModeModule {}
