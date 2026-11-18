import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-node';
import { StorageDisk, uploadToDisk } from '@nestjs/storage';
import type { UserPrincipal } from '../../../iam/auth/principal.js';
import { assertDeclaredType } from '../attachments.types.js';
import { avatarsConfig } from './avatars.config.js';
import { avatarKey, notWhileImpersonating } from './avatars.service.js';

/**
 * The types a picture may be, recognized from the file's bytes (never the
 * client's word or the name): the formats every browser shows in an <img>.
 * Not SVG (it scripts), not HEIC or AVIF (not shown everywhere).
 */
export const AVATAR_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

const Upload = FileInterceptor('file');

/**
 * The upload of the signed-in user's picture, from the multipart field
 * `file`: streamed onto the private disk under the account, its type read
 * from its bytes (415 unless PNG, JPEG, WebP or GIF, or when it is not what
 * the client declared), its size capped (413). Refused while impersonating
 * before anything is stored.
 */
@Injectable()
export class AvatarUpload implements NestInterceptor {
  private readonly multer: NestInterceptor;

  constructor(
    @Inject(avatarsConfig.KEY) config: ConfigType<typeof avatarsConfig>,
    @Inject(StorageDisk) disk: StorageDisk,
  ) {
    this.multer = new Upload({
      storage: uploadToDisk({
        disk,
        key: (file, req) => {
          assertDeclaredType(file.mimetype, file.contentType!);
          return avatarKey(
            (req as { user: UserPrincipal }).user.id,
            file.extension,
          );
        },
        contentTypes: AVATAR_TYPES,
      }),
      limits: { fileSize: config.maxBytes, files: 1 },
      defParamCharset: 'utf8',
    });
  }

  intercept(context: ExecutionContext, next: CallHandler) {
    notWhileImpersonating(
      context.switchToHttp().getRequest<{ user: UserPrincipal }>().user,
    );
    return this.multer.intercept(context, next);
  }
}
