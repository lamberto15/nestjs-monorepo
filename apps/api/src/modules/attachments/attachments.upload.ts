import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  type Type,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-node';
import { StorageDisk, uploadToDisk } from '@nestjs/storage';
import { z } from 'zod';
import type { Principal } from '../../iam/auth/principal.js';
import { attachmentsConfig } from './attachments.config.js';
import { AttachmentsService, attachmentKey } from './attachments.service.js';
import {
  assertDeclaredType,
  ATTACHMENT_SAMPLE_BYTES,
  detectAttachmentType,
} from './attachments.types.js';

const Upload = FileInterceptor('file');

/**
 * The upload of an attachment to a record of `subject` (its id in the route
 * parameter `id`), from the multipart field `file`. First the caller's right
 * to attach files to that record (404, 403), so nothing is stored for a
 * refused request; then multer with @nestjs/storage's `uploadToDisk()`, which
 * streams the file onto the private disk under the uploader's tenant: its
 * type recognized by its bytes (415 when not allowed, or not what the client
 * declared), its size capped (413). A class per call, as the limits come from
 * the configuration, which decorator arguments can't read.
 */
export function attachmentUpload(subject: string): Type<NestInterceptor> {
  @Injectable()
  class AttachmentUpload implements NestInterceptor {
    private readonly multer: NestInterceptor;

    constructor(
      private readonly attachments: AttachmentsService,
      @Inject(attachmentsConfig.KEY)
      config: ConfigType<typeof attachmentsConfig>,
      @Inject(StorageDisk) disk: StorageDisk,
    ) {
      this.multer = new Upload({
        storage: uploadToDisk({
          // The disk itself, not its name: uploadToDisk() finds a disk by name
          // through Express's or Fastify's request only, not the native adapter's.
          disk,
          // Under the uploader's tenant: the request's principal, authenticated
          // before any interceptor runs.
          key: (file, req) => {
            assertDeclaredType(file.mimetype, file.contentType!);
            return attachmentKey(
              (req as { user: Principal }).user,
              file.extension,
            );
          },
          contentTypes: [...config.types],
          detectContentType: detectAttachmentType,
          contentTypeSampleBytes: ATTACHMENT_SAMPLE_BYTES,
        }),
        limits: { fileSize: config.maxBytes, files: 1 },
        // Browsers send file names in UTF-8; busboy would read them as latin1.
        defParamCharset: 'utf8',
      });
    }

    async intercept(context: ExecutionContext, next: CallHandler) {
      const req = context
        .switchToHttp()
        .getRequest<{ user: Principal; params: Record<string, string> }>();
      const recordId = z.uuid().safeParse(req.params.id);
      if (!recordId.success) {
        throw new BadRequestException('Validation failed (uuid is expected)');
      }
      await this.attachments.assertCanUpload(req.user, {
        subject,
        recordId: recordId.data,
      });
      return this.multer.intercept(context, next);
    }
  }
  return AttachmentUpload;
}
