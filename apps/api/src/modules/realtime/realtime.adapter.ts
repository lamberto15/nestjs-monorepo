import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import { closeRedis, REDIS } from '../../core/redis/redis.js';

/** The namespace of the gateway (`/realtime`). */
export const REALTIME_NAMESPACE = 'realtime';

/**
 * The Redis channels' prefix, shared by the adapter and the emitter
 * (realtime.service.ts): the app's REDIS_PREFIX, so apps can share a Redis.
 */
export const channelKey = (redis: Redis) =>
  `${redis.options.keyPrefix ?? ''}socket.io`;

/**
 * socket.io with the Redis adapter (docs.nestjs.com/websockets/adapter): what
 * an instance emits reaches the clients connected to every other one. With
 * several instances behind a load balancer, clients connect with
 * `transports: ['websocket']` (or the balancer needs sticky sessions):
 * Redis alone doesn't make polling work.
 */
class RedisIoAdapter extends IoAdapter {
  private readonly clients: Redis[];
  private readonly adapter: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext, redis: Redis) {
    super(app);
    const pub = redis.duplicate();
    const sub = redis.duplicate();
    this.clients = [pub, sub];
    this.adapter = createAdapter(pub, sub, { key: channelKey(redis) });
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapter);
    return server;
  }

  override async close(server: Server) {
    await super.close(server);
    await Promise.all(this.clients.map((client) => closeRedis(client)));
  }
}

/** main.ts, before `listen()`: gateways run on socket.io, fanned out through Redis. */
export function setupRealtime(app: INestApplication) {
  app.useWebSocketAdapter(new RedisIoAdapter(app, app.get<Redis>(REDIS)));
}
