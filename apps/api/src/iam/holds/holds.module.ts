import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { LegalHoldsController } from './holds.controller.js';
import { HOLD_PERMISSIONS } from './holds.permissions.js';
import { LegalHoldPolicy } from './holds.policy.js';
import { LegalHoldsService } from './holds.service.js';

/**
 * Legal holds (README.md): the routes under /legal-holds and
 * LegalHoldsService, whose `assertNotHeld()` a delete calls. Needs
 * AuthModule (global), the tenancy and database modules.
 */
@Module({
  imports: [AccessModule.forFeature(HOLD_PERMISSIONS), AuditModule],
  controllers: [LegalHoldsController],
  providers: [LegalHoldsService, LegalHoldPolicy],
  exports: [LegalHoldsService],
})
export class HoldsModule {}
