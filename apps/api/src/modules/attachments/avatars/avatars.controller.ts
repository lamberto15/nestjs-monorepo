import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type {
  NodeRequest as Request,
  NodeResponse as Response,
} from '@nestjs/platform-node';
import { serveFile, StorageDisk, type StoredUpload } from '@nestjs/storage';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import type { UserPrincipal } from '../../../iam/auth/principal.js';
import { UserOnly } from '../../../iam/auth/user-only.decorator.js';
import { AvatarUpload } from './avatars.upload.js';
import { AvatarsService, notWhileImpersonating } from './avatars.service.js';

/** The result of setting a picture. */
export const avatarResultSchema = z.object({
  avatarUrl: z
    .string()
    .describe(
      'The path to show it by (`/v1/people/<id>/avatar?v=…`); a new picture is a new `v`.',
    ),
});

/**
 * The person's own picture. Users only, never while impersonating (the
 * picture is the account's, and an administrator acting as someone is not
 * them).
 */
@ApiTags('account')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'Not signed in as a user.' })
@UserOnly()
@Can.Anyone()
@Controller('account/avatar')
export class AvatarController {
  constructor(private readonly avatars: AvatarsService) {}

  @Put()
  @UseInterceptors(AvatarUpload)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Set your picture',
    description:
      'Multipart, the field `file`: a PNG, JPEG, WebP or GIF, recognized from its bytes (not the name or the declared type), at most AVATAR_MAX_MB (2). Replaces the one you had. The answer is the `avatarUrl` to show it by. Audited (account.avatar-changed). Never while acting as another user.',
  })
  @ApiOkResponse({ standardSchema: avatarResultSchema })
  @ApiBadRequestResponse({ description: 'No file (validation_failed).' })
  @ApiForbiddenResponse({ description: 'Acting as another user.' })
  @ApiPayloadTooLargeResponse({ description: 'Larger than AVATAR_MAX_MB.' })
  @ApiUnsupportedMediaTypeResponse({
    description: 'Not a PNG, JPEG, WebP or GIF, or not the type declared.',
  })
  set(
    @CurrentUser() user: UserPrincipal,
    @UploadedFile() file: StoredUpload | undefined,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    if (!file) {
      throw new BadRequestException('Attach the picture as the "file" field.');
    }
    return this.avatars.set(user, file, ip);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove your picture',
    description:
      'The file goes too. Without a picture, nothing happens. Audited (account.avatar-removed). Never while acting as another user.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'Acting as another user.' })
  async remove(@CurrentUser() user: UserPrincipal, @Ip() ip: string) {
    notWhileImpersonating(user);
    await this.avatars.remove(user, ip);
  }
}

/** A person's picture, for the members of a tenant they belong to. */
@ApiTags('people')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'Not signed in as a user.' })
@UserOnly()
@Can.Anyone()
@Controller('people')
export class PeopleAvatarController {
  constructor(
    private readonly avatars: AvatarsService,
    private readonly disk: StorageDisk,
  ) {}

  @Get(':id/avatar')
  @ApiOperation({
    summary: "A person's picture",
    description:
      "The image itself (inline, private cache), streamed from the API's own origin so that an <img> can show it. A member of your tenant, or you; else 404.",
  })
  @ApiNotFoundResponse({
    description: 'No picture, or not a member of your tenant.',
  })
  async show(
    @CurrentUser() viewer: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return serveFile(this.disk, await this.avatars.keyOf(viewer, id), {
      req,
      res,
      disposition: 'inline',
      cacheControl: 'private, max-age=300',
    });
  }
}
