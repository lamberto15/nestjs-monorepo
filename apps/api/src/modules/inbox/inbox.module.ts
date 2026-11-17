import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';
import { InboxSources } from './inbox.source.js';

/**
 * The work inbox (README.md): `GET /v1/inbox`, one list of what waits on the
 * caller, merged from the sources other modules provide with
 * `@InboxSourceOf('name')` (inbox.source.ts). Needs AuthModule (global).
 */
@Module({
  imports: [DiscoveryModule],
  controllers: [InboxController],
  providers: [InboxSources, InboxService],
})
export class InboxModule {}
