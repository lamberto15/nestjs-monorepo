import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser, Public } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiProduces,
  ApiTags,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { StoredUpload } from '@nestjs/storage';
import { requestHostname } from '../../iam/auth/host-tenant.js';
import type { Principal } from '../../iam/auth/principal.js';
import { FILE_CSP } from '../storage/files.controller.js';
import {
  BrandingDarkLogoUpload,
  BrandingLogoUpload,
} from './branding-logo-upload.interceptor.js';
import { BrandingPolicy } from './branding.policy.js';
import {
  brandingSchema,
  logoUploadSchema,
  publicBrandSchema,
  updateBrandingSchema,
  type UpdateBranding,
} from './branding.schemas.js';
import { BrandingService, LOGO_TYPES } from './branding.service.js';

const locked = 'Locked by the operators (branding_locked).';

/**
 * The tenant's branding: colour, mail sender name and logo. Reading is for
 * everyone signed in (the web app themes itself from it); changing it is
 * `Branding.update`, unless the operators locked it.
 */
@ApiTags('branding')
@Controller('branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  @Can.Anyone()
  @ApiOperation({
    summary: 'The branding of your tenant',
    description:
      'The brand colour (`#rrggbb`), the name mail is sent under, the logo’s path, whether the operators locked it and whether you may change it.',
  })
  @ApiOkResponse({ standardSchema: brandingSchema })
  get(@CurrentUser() user: Principal) {
    return this.branding.view(user);
  }

  @Put()
  @Can(BrandingPolicy, 'update')
  @ApiOperation({
    summary: 'Change the branding of your tenant',
    description:
      'Sets the colour and the sender name (the settings `branding.primaryColor` and `branding.mailFromName`, so audited as `setting.updated`): `null` removes one, an absent key stays. The colour is `#rrggbb` only. Answers 409 `branding_locked` while the operators have it locked.',
  })
  @ApiOkResponse({ standardSchema: brandingSchema })
  @ApiConflictResponse({ description: locked })
  update(
    @CurrentUser() user: Principal,
    @Body({ schema: updateBrandingSchema }) body: UpdateBranding,
    @Ip() ip: string,
  ) {
    return this.branding.update(user, body, ip);
  }

  @Post('logo')
  @Can(BrandingPolicy, 'update')
  @UseInterceptors(BrandingLogoUpload)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Set the logo of your tenant',
    description:
      'Multipart, the field `file`: a PNG, JPEG or WebP of at most 512 KB, recognized by its bytes (never SVG). Replaces the logo. Audited (`branding.logo-changed`). 409 `branding_locked` while locked.',
  })
  @ApiCreatedResponse({ standardSchema: brandingSchema })
  @ApiConflictResponse({ description: locked })
  @ApiPayloadTooLargeResponse({ description: 'Larger than 512 KB.' })
  @ApiUnsupportedMediaTypeResponse({ description: 'Not a PNG, JPEG or WebP.' })
  upload(
    @CurrentUser() user: Principal,
    @UploadedFile() file: StoredUpload | undefined,
    @Body({ schema: logoUploadSchema }) _body: unknown,
    @Ip() ip: string,
  ) {
    return this.branding.logoUploaded(user, file, 'light', ip);
  }

  @Post('logo/dark')
  @Can(BrandingPolicy, 'update')
  @UseInterceptors(BrandingDarkLogoUpload)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Set the dark-mode logo of your tenant',
    description:
      'Like the logo (the same types, size and checks), shown by the web app in its dark theme. Audited (`branding.logo-changed`, `variant: dark`). 409 `branding_locked` while locked.',
  })
  @ApiCreatedResponse({ standardSchema: brandingSchema })
  @ApiConflictResponse({ description: locked })
  @ApiPayloadTooLargeResponse({ description: 'Larger than 512 KB.' })
  @ApiUnsupportedMediaTypeResponse({ description: 'Not a PNG, JPEG or WebP.' })
  uploadDark(
    @CurrentUser() user: Principal,
    @UploadedFile() file: StoredUpload | undefined,
    @Body({ schema: logoUploadSchema }) _body: unknown,
    @Ip() ip: string,
  ) {
    return this.branding.logoUploaded(user, file, 'dark', ip);
  }

  @Delete('logo')
  @Can(BrandingPolicy, 'update')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove the logo of your tenant',
    description:
      'The file goes too. Audited (`branding.logo-removed`). 409 `branding_locked` while locked.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'There is no logo.' })
  @ApiConflictResponse({ description: locked })
  async remove(@CurrentUser() user: Principal, @Ip() ip: string) {
    await this.branding.removeLogo(user, 'light', ip);
  }

  @Delete('logo/dark')
  @Can(BrandingPolicy, 'update')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove the dark-mode logo of your tenant',
    description:
      'The file goes too; the logo is shown in the dark theme again. Audited (`branding.logo-removed`). 409 `branding_locked` while locked.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'There is no dark-mode logo.' })
  @ApiConflictResponse({ description: locked })
  async removeDark(@CurrentUser() user: Principal, @Ip() ip: string) {
    await this.branding.removeLogo(user, 'dark', ip);
  }
}

/**
 * A tenant's logo, without a sign-in: mail clients and the sign-in page
 * show it. A logo is a public asset (it is in every mail the tenant sends);
 * it names its tenant by id, which is not a secret either, and nothing else
 * of the tenant is reachable from here.
 */
@ApiTags('branding')
@Public()
@Controller('branding')
export class PublicBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get(':tenantId/logo')
  @ApiOperation({
    summary: 'The logo of a tenant',
    description:
      "No sign-in needed. The image itself (PNG, JPEG or WebP, the type its bytes say), cached for five minutes, with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `Cross-Origin-Resource-Policy: cross-origin` (other sites' mail pages and apps may show it).",
  })
  @ApiProduces(...LOGO_TYPES)
  @ApiOkResponse({ description: 'The image.' })
  @ApiNotFoundResponse({ description: 'The tenant has no logo.' })
  // An image is never a page: nothing loads, nothing runs, whatever the
  // bytes hold; the policy replaces the API's own (Swagger UI's).
  @Header('Content-Security-Policy', FILE_CSP)
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @Header('Cache-Control', 'public, max-age=300')
  async logo(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.serve(await this.branding.logoFile(tenantId, 'light'));
  }

  @Get(':tenantId/logo/dark')
  @ApiOperation({
    summary: 'The dark-mode logo of a tenant',
    description:
      'No sign-in needed. Like the logo, with the same headers: the image the web app shows in its dark theme.',
  })
  @ApiProduces(...LOGO_TYPES)
  @ApiOkResponse({ description: 'The image.' })
  @ApiNotFoundResponse({ description: 'The tenant has no dark-mode logo.' })
  @Header('Content-Security-Policy', FILE_CSP)
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @Header('Cache-Control', 'public, max-age=300')
  async darkLogo(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.serve(await this.branding.logoFile(tenantId, 'dark'));
  }

  private serve(file: Awaited<ReturnType<BrandingService['logoFile']>>) {
    return new StreamableFile(file.body, {
      type: file.contentType,
      length: file.size,
      disposition: 'inline',
    });
  }
}

/**
 * The brand of the host the request came to, before sign-in: the web app's
 * sign-in page on a tenant's custom domain. The host is the request's own
 * `Host` (never a parameter, never X-Forwarded-Host): a page can only learn
 * the brand of the domain it is on.
 */
@ApiTags('branding')
@Public()
@Controller('branding')
export class HostBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get('host')
  @ApiOperation({
    summary: 'The brand of the host you reached the app on',
    description:
      "No sign-in needed. On a tenant's verified custom domain, its colours, sender name and logos; on any other host (the app's own, an unknown one, a domain removed), every field null. Never names the tenant otherwise. Not cached: a removed domain stops at once.",
  })
  @ApiOkResponse({ standardSchema: publicBrandSchema })
  @Header('Cache-Control', 'no-store')
  host(@Headers('host') host: string | undefined) {
    return this.branding.brandOfHost(requestHostname(host));
  }
}
