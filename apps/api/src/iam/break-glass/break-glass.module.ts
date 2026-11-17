import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { OperatorGuard } from '../auth/operator-only.js';
import { BreakGlassController } from './break-glass.controller.js';
import { BreakGlassGuard } from './break-glass.guard.js';
import { BREAK_GLASS_PERMISSIONS } from './break-glass.permissions.js';
import { BreakGlassPolicy } from './break-glass.policy.js';
import { BreakGlassService } from './break-glass.service.js';

/**
 * Break-glass (README.md): the operators' grants and the global guard
 * that checks a request naming one (and, until core/tenancy has a
 * read-only scope, refuses it). Needs AuthModule, AccessModule,
 * AuditModule, EventEmitterModule.forRoot().
 */
@Module({
  imports: [AccessModule.forFeature(BREAK_GLASS_PERMISSIONS), AuditModule],
  controllers: [BreakGlassController],
  providers: [
    BreakGlassService,
    BreakGlassPolicy,
    OperatorGuard,
    { provide: APP_GUARD, useClass: BreakGlassGuard },
  ],
})
export class BreakGlassModule {}
