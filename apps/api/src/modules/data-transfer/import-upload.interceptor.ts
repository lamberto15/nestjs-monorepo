import { randomUUID } from 'node:crypto';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { FileInterceptor, type NodeRequest } from '@nestjs/platform-node';
import { StorageDisk, uploadToDisk } from '@nestjs/storage';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import type { ImportLimits as Limits } from './data-transfer.types.js';
import { transferKey } from './data-transfer.service.js';
import { CONTENT_TYPES, detectTextFormat } from './formats.js';
import { ImportLimits } from './import-limits.js';

/** The request of an import, once this interceptor ran: the limits it was accepted under. */
export type ImportRequest = NodeRequest & {
  user: RequestPrincipal;
  importLimits: Limits;
};

/**
 * The upload of an import (`FileInterceptor('file')` with `uploadToDisk()`),
 * streamed to the private disk under the tenant's prefix, its type checked
 * from its bytes. Around it: the size limit is the caller's (a tenant
 * setting, read asynchronously once they are signed in), resolved first
 * and read by multer's `limits` function of the request.
 */
@Injectable()
export class ImportUpload implements NestInterceptor {
  private readonly upload: NestInterceptor;

  constructor(
    private readonly limits: ImportLimits,
    disk: StorageDisk,
  ) {
    const Upload = FileInterceptor('file', {
      storage: uploadToDisk({
        // The disk itself: uploadToDisk() finds one by name through Express's
        // or Fastify's request only, not the native adapter's.
        disk,
        key: (_file, request: ImportRequest) =>
          transferKey(request.user.tenantId!, `uploads/${randomUUID()}`),
        contentTypes: [
          CONTENT_TYPES.csv,
          CONTENT_TYPES.xlsx,
          'application/zip',
        ],
        detectContentType: detectTextFormat,
      }),
      limits: (request: ImportRequest) => ({
        fileSize: request.importLimits.maxBytes,
        files: 1,
      }),
    });
    this.upload = new Upload();
  }

  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<ImportRequest>();
    requireTenantId('An import');
    request.importLimits = await this.limits.for(request.user);
    return this.upload.intercept(context, next);
  }
}
