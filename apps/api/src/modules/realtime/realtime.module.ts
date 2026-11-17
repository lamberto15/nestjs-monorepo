import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeDisconnects } from './realtime.listeners.js';
import { Realtime } from './realtime.service.js';

/**
 * Live events to browsers and apps (README.md). Import it in the module that
 * pushes: `Realtime` is what it injects. Needs `setupRealtime(app)` in
 * main.ts (the socket.io adapter on Redis).
 */
@Module({
  providers: [Realtime, RealtimeGateway, RealtimeDisconnects],
  exports: [Realtime],
})
export class RealtimeModule {}
