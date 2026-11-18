import { Controller, Get } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { captchaSettingsSchema } from './captcha.schemas.js';
import { CaptchaService } from './captcha.service.js';

const captchaSchema = z.object({ captcha: captchaSettingsSchema });

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
