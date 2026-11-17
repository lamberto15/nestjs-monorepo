import { Controller, Get, Module, VERSION_NEUTRAL } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import { authModules, createUser, signIn } from '../../../test/auth.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { memberships } from './auth.tables.js';
import { OperatorOnly } from './operator-only.js';
import type { RequestPrincipal } from './principal.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.TENANCY = 'single';
  process.env.REDIS_PREFIX = `test-single-${process.pid}-${Date.now()}`;
});

@Controller({ path: 'probe', version: VERSION_NEUTRAL })
class ProbeController {
  @Get('me')
  me(@CurrentUser() user: RequestPrincipal) {
    return user;
  }

  @Get('operators')
  @OperatorOnly()
  operators() {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

/** TENANCY=single: every host is the one tenant's, and its members are the operators. */
describe('sign-in with TENANCY=single (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;

  beforeAll(async () => {
    app = await bootModules(...authModules(), ProbeModule);
    tenantId = (await app.get(Tenancy).soleTenant()).id;
  });
  afterAll(async () => {
    await app.close();
    delete process.env.TENANCY;
  });

  it('acts in the one tenant, whose members are the operators', async () => {
    const { email } = await createUser(app, { tenantId });
    const { headers } = await signIn(app, email);
    const me = await app.inject({ method: 'GET', url: '/probe/me', headers });
    expect(me.json()).toMatchObject({ tenantId });
    const ops = await app.inject({
      method: 'GET',
      url: '/probe/operators',
      headers,
    });
    expect(ops.statusCode).toBe(200);
  });

  it('gives an account without a membership no tenant, and no operator routes', async () => {
    const { user, email } = await createUser(app, { tenantId });
    await app
      .get<Database>(getDrizzleToken())
      .delete(memberships)
      .where(eq(memberships.userId, user.id));
    const { headers } = await signIn(app, email);
    const me = await app.inject({ method: 'GET', url: '/probe/me', headers });
    expect(me.json()).toMatchObject({ tenantId: null });
    const ops = await app.inject({
      method: 'GET',
      url: '/probe/operators',
      headers,
    });
    expect(ops.statusCode).toBe(403);
    expect(ops.json()).toMatchObject({ code: 'operator_required' });
  });
});
