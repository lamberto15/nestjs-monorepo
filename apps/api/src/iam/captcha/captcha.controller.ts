import { Controller, Get } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CaptchaService } from './captcha.service.js';

const captchaSchema = z.object({
  captcha: z
    .object({
      provider: z.string().describe('`turnstile` (or `stub` in tests).'),
      siteKey: z.string().nullable().describe("The widget's public key."),
      mode: z
        .enum(['always', 'after-failures'])
        .describe(
          '`always`: render the widget up front. `after-failures`: only when a 403 `captcha_required` asks.',
        ),
    })
    .nullable()
    .describe('null: bot protection is off.'),
});

/** What a page needs to render the challenge widget. */
@ApiTags('auth')
@Public()
@Controller('auth/captcha')
export class CaptchaController {
  constructor(private readonly captcha: CaptchaService) {}

  @Get()
  @ApiOperation({
    summary: 'The bot protection in force, to render its widget',
  })
  @ApiOkResponse({ standardSchema: captchaSchema })
  settings() {
    return { captcha: this.captcha.settings() };
  }
}
