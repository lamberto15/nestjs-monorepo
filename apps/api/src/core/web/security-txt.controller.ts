import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import type { ConfigType } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { webConfig } from './web.config.js';

/** How far ahead `Expires` is when SECURITY_TXT_EXPIRES is unset. */
const ROLLING_DAYS = 180;

/** A contact as security.txt takes it: a bare address becomes `mailto:`. */
export const contactUri = (contact: string) =>
  /^(?:mailto:|https:\/\/)/.test(contact) ? contact : `mailto:${contact}`;

/**
 * `/.well-known/security.txt` (RFC 9116): where to report a vulnerability,
 * from SECURITY_CONTACT, with the `Expires` the RFC requires. 404 when no
 * contact is set. Not in the OpenAPI document: no client calls it.
 */
@ApiExcludeController()
@Public()
@Controller({ path: '.well-known', version: VERSION_NEUTRAL })
export class SecurityTxtController {
  constructor(
    @Inject(webConfig.KEY)
    private readonly config: ConfigType<typeof webConfig>,
  ) {}

  @Get('security.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=86400')
  securityTxt() {
    const { securityContact, securityTxtExpires } = this.config;
    if (!securityContact) {
      throw new NotFoundException();
    }
    const expires = securityTxtExpires
      ? new Date(securityTxtExpires)
      : new Date(Date.now() + ROLLING_DAYS * 86_400_000);
    return [
      `Contact: ${contactUri(securityContact)}`,
      `Expires: ${expires.toISOString()}`,
      'Preferred-Languages: en',
      '',
    ].join('\n');
  }
}
