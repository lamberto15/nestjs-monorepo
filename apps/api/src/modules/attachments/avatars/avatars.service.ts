import { randomUUID } from 'node:crypto';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { t } from '@nestjs/i18n';
import { StorageDisk, type StoredUpload } from '@nestjs/storage';
import { and, eq } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../../core/database/database.js';
import { requireTenantId } from '../../../core/tenancy/tenant-scope.js';
import { AuditService } from '../../../iam/audit/audit.service.js';
import { memberships } from '../../../iam/auth/auth.tables.js';
import type { Principal, UserPrincipal } from '../../../iam/auth/principal.js';
import {
  ImageProcessor,
  ImageRejectedError,
} from '../../images/image-processor.js';
import { accountFileKey } from '../../storage/storage.keys.js';
import { userAvatars } from './avatars.tables.js';

/**
 * Refuses an administrator acting as the person (impersonation): the
 * picture is the account's own, not changed from outside. A 403.
 */
export function notWhileImpersonating(principal: Principal) {
  if (principal.kind === 'user' && principal.impersonator) {
    throw new ForbiddenException({
      code: 'impersonating',
      message: 'Not while acting as another user.',
    });
  }
}

/** The key of a new picture: under the account, not a tenant (one account, many tenants). */
export const avatarKey = (userId: string, extension: string) =>
  accountFileKey(userId, `avatar/${randomUUID()}${extension}`);

/**
 * The stable path a picture is shown by: not a signed link, so an <img> can
 * hold it; a new picture is a new `v`, so a browser's cached one is not
 * shown again.
 */
export const avatarUrl = (userId: string, key: string) =>
  `/v1/people/${userId}/avatar?v=${key.split('/').pop()!.split('.')[0]}`;

/**
 * The picture of a user's account (`PUT`, `DELETE /v1/account/avatar`). The
 * file is on the private disk under the account, its key in
 * `user_avatars`; the row change and its audit entry
 * (`account.avatar-changed`, `account.avatar-removed`) commit together, and
 * the file it replaces goes after the commit. Seen by the members of a
 * tenant the person belongs to (`GET /v1/people/{id}/avatar`, which streams
 * the file from the API's own origin).
 *
 * Stored as uploaded (type and size checked), but for its metadata: the
 * EXIF of a phone's photo (its GPS position among it) is stripped before
 * any member can see it. Not resized.
 */
@Injectable()
export class AvatarsService {
  private readonly logger = new Logger('Avatars');

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly audit: AuditService,
    private readonly disk: StorageDisk,
    private readonly images: ImageProcessor,
  ) {}

  /** Records the stored file (`file.key`) as the user's picture. Failed, the file is deleted. */
  async set(user: UserPrincipal, file: StoredUpload, ip?: string) {
    try {
      const size = await this.stripMetadata(file);
      const previous = await this.change(user, file.key, ip, {
        size,
        contentType: file.contentType,
      });
      await this.dispose(previous);
      return { avatarUrl: avatarUrl(user.id, file.key) };
    } catch (error) {
      await this.dispose(file.key);
      throw error;
    }
  }

  /** The stored file rewritten without its metadata, when it had some: its size then. A file the processor refuses is a 415. */
  private async stripMetadata(file: StoredUpload) {
    let stripped;
    try {
      stripped = await this.images.strip(await this.disk.getBuffer(file.key));
    } catch (error) {
      if (error instanceof ImageRejectedError) {
        throw new UnsupportedMediaTypeException(t('attachments.badPicture'));
      }
      throw error;
    }
    if (!stripped) return file.size;
    await this.disk.put(file.key, stripped.data, {
      contentType: file.contentType,
    });
    return stripped.data.length;
  }

  /** Removes the picture, file and row; nothing to do without one. */
  async remove(user: UserPrincipal, ip?: string) {
    await this.dispose(await this.change(user, null, ip));
  }

  /** The picture's path of each of these users, for what lists people (null for none). */
  async urlOf(userId: string) {
    const [row] = await this.db
      .select({ key: userAvatars.key })
      .from(userAvatars)
      .where(eq(userAvatars.userId, userId));
    return row ? avatarUrl(userId, row.key) : null;
  }

  /**
   * The disk key of a user's picture, for a member of the tenant the viewer
   * acts in (or the user themselves): 404 for anyone else or when there is
   * no picture, so it never tells those apart.
   */
  async keyOf(viewer: UserPrincipal, userId: string) {
    const tenantId = requireTenantId('A picture');
    const [row] =
      viewer.id === userId
        ? await this.db
            .select({ key: userAvatars.key })
            .from(userAvatars)
            .where(eq(userAvatars.userId, userId))
        : await this.db
            .select({ key: userAvatars.key })
            .from(userAvatars)
            .innerJoin(
              memberships,
              and(
                eq(memberships.userId, userAvatars.userId),
                eq(memberships.tenantId, tenantId),
              ),
            )
            .where(eq(userAvatars.userId, userId));
    if (!row) throw new NotFoundException('No picture.');
    return row.key;
  }

  /** The key change and its audit entry in one transaction; the key it replaced. */
  private async change(
    user: UserPrincipal,
    key: string | null,
    ip: string | undefined,
    details?: Record<string, unknown>,
  ) {
    return this.txHost.withTransaction(async () => {
      const [before] = await this.db
        .select({ key: userAvatars.key })
        .from(userAvatars)
        .where(eq(userAvatars.userId, user.id))
        .for('update');
      if (key) {
        await this.db
          .insert(userAvatars)
          .values({ userId: user.id, key })
          .onConflictDoUpdate({ target: userAvatars.userId, set: { key } });
      } else {
        await this.db
          .delete(userAvatars)
          .where(eq(userAvatars.userId, user.id));
      }
      if (key !== null || before) {
        await this.audit.record(user, {
          action: key ? 'account.avatar-changed' : 'account.avatar-removed',
          targetType: 'user',
          targetId: user.id,
          details,
          ip,
        });
      }
      return before?.key ?? null;
    });
  }

  /** Deletes a replaced or abandoned file; a failure leaves an orphan, never a failed request. */
  private async dispose(key: string | null) {
    if (!key) return;
    await this.disk.delete(key).catch((error: unknown) =>
      this.logger.warn('An avatar file was not deleted', {
        key,
        error: String(error),
      }),
    );
  }
}
