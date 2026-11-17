import { EventEmitter } from 'node:events';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Captcha, type CaptchaOptions } from './captcha.decorator.js';
import { CaptchaGuard } from './captcha.guard.js';
import type { CaptchaRequest, CaptchaService } from './captcha.service.js';

/** What the guard told the service: each check's subject, each release's. */
function fakeCaptcha(mode = 'after-failures') {
  const checked: CaptchaRequest[] = [];
  const released: Pick<CaptchaRequest, 'ip' | 'email'>[] = [];
  const service = {
    mode,
    check: async (_token: string | undefined, subject: CaptchaRequest) => {
      checked.push(subject);
    },
    release: async (subject: Pick<CaptchaRequest, 'ip' | 'email'>) => {
      released.push(subject);
    },
  } as unknown as CaptchaService;
  return { service, checked, released };
}

/** A route decorated with @Captcha(options) (or not), and a request to it. */
function call(options: CaptchaOptions | undefined, body: unknown) {
  class Route {
    @(options ? Captcha(options) : () => undefined)
    handle(this: void) {}
  }
  const response = Object.assign(new EventEmitter(), { statusCode: 200 });
  const req = { ip: '203.0.113.7', body, headers: {}, method: 'POST' };
  const context = {
    getType: () => 'http',
    getHandler: () => Route.prototype.handle,
    getClass: () => Route,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return { context, response };
}

describe('CaptchaGuard', () => {
  it("checks a marked route with the address and the body's email", async () => {
    const captcha = fakeCaptcha();
    const route = call(
      { action: 'sign-in', count: 'failures' },
      { email: 'someone@example.com' },
    );
    const guard = new CaptchaGuard(new Reflector(), captcha.service);
    expect(await guard.canActivate(route.context)).toBe(true);
    expect(captcha.checked).toEqual([
      { ip: '203.0.113.7', email: 'someone@example.com', action: 'sign-in' },
    ]);
  });

  it('leaves an unmarked route, and every route while the mode is off, alone', async () => {
    const unmarked = fakeCaptcha();
    await new CaptchaGuard(new Reflector(), unmarked.service).canActivate(
      call(undefined, {}).context,
    );
    const off = fakeCaptcha('off');
    await new CaptchaGuard(new Reflector(), off.service).canActivate(
      call({ action: 'sign-in', count: 'failures' }, {}).context,
    );
    expect([...unmarked.checked, ...off.checked]).toEqual([]);
  });

  it('gives the attempt back only when a "failures" route answered no 4xx', async () => {
    const captcha = fakeCaptcha();
    const guard = new CaptchaGuard(new Reflector(), captcha.service);
    const failed = call({ action: 'sign-in', count: 'failures' }, {});
    await guard.canActivate(failed.context);
    failed.response.statusCode = 401;
    failed.response.emit('finish');
    expect(captcha.released).toEqual([]);

    const ok = call({ action: 'sign-in', count: 'failures' }, {});
    await guard.canActivate(ok.context);
    ok.response.emit('finish');
    expect(captcha.released).toHaveLength(1);

    const requests = call({ action: 'forgot-password', count: 'requests' }, {});
    await guard.canActivate(requests.context);
    requests.response.emit('finish');
    expect(captcha.released).toHaveLength(1);
  });
});
