import {
  Controller,
  Get,
  Header,
  NotFoundException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { ApiExcludeController } from '@nestjs/swagger';
import { PasskeysService } from './passkeys.service.js';

/**
 * What the operating systems read to let native apps use this site's
 * passkeys: Android's Digital Asset Links and Apple's app site association,
 * both JSON, built from PASSKEY_ANDROID_APPS and PASSKEY_APPLE_APPS. They
 * must be served on the RP ID's host: with the web app on this API's
 * domain, that is here. 404 when no app is configured. Not in the OpenAPI
 * document: no client calls them.
 */
@ApiExcludeController()
@Public()
@Controller({ path: '.well-known', version: VERSION_NEUTRAL })
export class WellKnownController {
  constructor(private readonly passkeys: PasskeysService) {}

  @Get('assetlinks.json')
  @Header('Cache-Control', 'public, max-age=3600')
  assetLinks() {
    const { settings } = this.passkeys;
    const apps = settings.enabled ? settings.androidApps : [];
    if (apps.length === 0) {
      throw new NotFoundException();
    }
    return apps.map((app) => ({
      relation: [
        'delegate_permission/common.handle_all_urls',
        'delegate_permission/common.get_login_creds',
      ],
      target: {
        namespace: 'android_app',
        package_name: app.packageName,
        sha256_cert_fingerprints: [app.fingerprint],
      },
    }));
  }

  @Get('apple-app-site-association')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  appleAppSiteAssociation() {
    const { settings } = this.passkeys;
    const apps = settings.enabled ? settings.appleApps : [];
    if (apps.length === 0) {
      throw new NotFoundException();
    }
    return { webcredentials: { apps } };
  }
}
