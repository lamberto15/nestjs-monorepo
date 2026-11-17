import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type {
  NodeRequest as Request,
  NodeResponse as Response,
} from '@nestjs/platform-node';
import {
  ATTESTATION_HEADER,
  CAPTCHA,
  CAPTCHA_HEADER,
  type CaptchaOptions,
} from './captcha.decorator.js';
import { CaptchaService } from './captcha.service.js';

/**
 * Global guard (CaptchaModule): checks the routes marked `@Captcha()`.
 * List the module after ThrottlingModule so a flood is refused before any
 * token is verified.
 */
@Injectable()
export class CaptchaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly captcha: CaptchaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const options = this.reflector.getAllAndOverride<
      CaptchaOptions | undefined
    >(CAPTCHA, [context.getHandler(), context.getClass()]);
    if (
      options &&
      context.getType() === 'http' &&
      this.captcha.mode !== 'off'
    ) {
      await this.verify(context, options);
    }
    // A refusal is thrown by check() (a problem with its code and detail),
    // never returned as `false`: a guard's `false` is a bare 403.
    return true;
  }

  private async verify(context: ExecutionContext, options: CaptchaOptions) {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const email = (request.body as { email?: unknown } | undefined)?.email;
    const subject = {
      ip: request.ip ?? '',
      email: typeof email === 'string' ? email : undefined,
      action: options.action,
    };
    if (options.count === 'failures') {
      // The attempt is counted (reserved) in check(), before anything is
      // judged; an answer that is no failure gives it back. A refused token
      // is a 4xx and stays counted; a dropped connection (no 'finish')
      // keeps the reservation: conservative, and no path skips counting.
      response.once('finish', () => {
        if (response.statusCode < 400) {
          void this.captcha.release(subject);
        }
      });
    }
    await this.captcha.check(
      headerValue(request, CAPTCHA_HEADER),
      subject,
      headerValue(request, ATTESTATION_HEADER),
    );
  }
}

/** The header's value, trimmed; undefined when absent or empty. */
function headerValue(request: Request, name: string) {
  const raw = request.headers[name.toLowerCase()];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value || undefined;
}
