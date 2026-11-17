import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AccessModule } from '../../iam/access/access.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { PresenceController } from './presence.controller.js';
import { PresenceRecords } from './presence.records.js';
import { PresenceService } from './presence.service.js';

/** Who is on a record now (README.md). */
@Module({
  imports: [AccessModule, DiscoveryModule, RealtimeModule],
  controllers: [PresenceController],
  providers: [PresenceService, PresenceRecords],
})
export class PresenceModule {}
