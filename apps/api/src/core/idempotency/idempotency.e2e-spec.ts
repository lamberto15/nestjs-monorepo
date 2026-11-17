import { randomUUID } from 'node:crypto';
import {
  type CallHandler,
  type CanActivate,
  Body,
  Controller,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  Module,
  Post,
  UseGuards,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import { DatabaseModule } from '../database/database.module.js';
import { EncryptionModule } from '../encryption/encryption.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { SharedIdempotencyModule } from './idempotency.module.js';
import { IdempotentRoute } from './idempotent-route.js';

const stats = { handled: 0, later: 0 };

/** A stand-in for sign-in: the caller a request names in a header. */
@Injectable()
class TestCallerGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
    }>();
    const id = request.headers['x-test-user'];
    if (id) request.user = { kind: 'user', id, tenantId: null };
    return true;
  }
}

/** An interceptor of a module listed after the idempotency module: a replay must not reach it. */
@Injectable()
class LaterInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    stats.later++;
    return next.handle();
  }
}

@Controller('orders')
@UseGuards(TestCallerGuard)
class OrdersController {
  @Post()
  @IdempotentRoute()
  create(@Body() body: { item: string }) {
    stats.handled++;
    return { id: randomUUID(), item: body.item };
  }

  @Post('keyless')
  @IdempotentRoute({ required: false })
  keyless() {
    return { id: randomUUID() };
  }
}

@Module({
  controllers: [OrdersController],
  providers: [
    TestCallerGuard,
    { provide: APP_INTERCEPTOR, useClass: LaterInterceptor },
  ],
})
class OrdersModule {}

describe('idempotency (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      DatabaseModule,
      TenancyModule,
      EncryptionModule,
      SecretsModule,
      SharedIdempotencyModule,
      OrdersModule,
    );
  });
  afterAll(() => app.close());
  beforeEach(() => {
    stats.handled = 0;
    stats.later = 0;
  });

  const post = (
    url: string,
    key: string | undefined,
    body: object = { item: 'a' },
    user = 'u1',
  ) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        'x-test-user': user,
        ...(key ? { 'idempotency-key': key } : {}),
      },
      payload: body,
    });

  it('runs the handler once per key and replays the response, outside the other interceptors', async () => {
    const key = randomUUID();
    const first = await post('/v1/orders', key);
    const second = await post('/v1/orders', key);
    expect(first.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(stats).toEqual({ handled: 1, later: 1 });
  });

  it('refuses a key reused for another request, and a request without a key', async () => {
    const key = randomUUID();
    await post('/v1/orders', key);
    const reused = await post('/v1/orders', key, { item: 'b' });
    expect(reused.statusCode).toBe(422);
    expect(reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const missing = await post('/v1/orders', undefined);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect((await post('/v1/orders/keyless', undefined)).statusCode).toBe(201);
  });

  it('keeps the keys of each caller apart', async () => {
    const key = randomUUID();
    const alice = await post('/v1/orders', key, { item: 'a' }, 'alice');
    const bob = await post('/v1/orders', key, { item: 'a' }, 'bob');
    expect(bob.json().id).not.toBe(alice.json().id);
    expect(stats.handled).toBe(2);
  });
});
