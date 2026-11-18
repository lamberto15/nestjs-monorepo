import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { OperatorGuard } from '../auth/operator-only.js';
import { BreakGlassController } from './break-glass.controller.js';
import { BREAK_GLASS_PERMISSIONS } from './break-glass.permissions.js';
import { BreakGlassPolicy } from './break-glass.policy.js';
import { BreakGlassService } from './break-glass.service.js';

/**
 * Break-glass (README.md): the operators' grants, and the source auth's
 * PrincipalGuard asks when a request names one (BreakGlassService,
 * `@BreakGlassGrantSource()`). Needs AuthModule, AccessModule,
 * AuditModule, SharedOutboxModule.
 */
@Module({
  imports: [AccessModule.forFeature(BREAK_GLASS_PERMISSIONS), AuditModule],
  controllers: [BreakGlassController],
  providers: [BreakGlassService, BreakGlassPolicy, OperatorGuard],
})
export class BreakGlassModule {}
