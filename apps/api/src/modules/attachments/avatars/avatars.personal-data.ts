import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable, Logger } from '@nestjs/common';
import { StorageDisk } from '@nestjs/storage';
import { eq } from 'drizzle-orm';
import type { Database } from '../../../core/database/database.js';
import {
  WhoAmIPart,
  type WhoAmIProvider,
  type WhoAmIRequest,
} from '../../../iam/auth/who-am-i.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../../iam/personal-data/personal-data.js';
import { accountFileKey } from '../../storage/storage.keys.js';
import { AvatarsService, avatarUrl } from './avatars.service.js';
import { userAvatars } from './avatars.tables.js';

/**
 * The person's picture: its address in their export. With their account the
 * row goes, and every file under `accounts/<id>/avatar/`, not only the one
 * the row named (a replaced picture whose delete failed is an orphan nothing
 * points at, and would outlive the person). A failed delete is logged, never
 * fails the erasure.
 */
@PersonalData({ name: 'avatar', scopes: ['account'] })
@Injectable()
export class AvatarsPersonalData implements PersonalDataSection {
  private readonly logger = new Logger('Avatars');

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly disk: StorageDisk,
  ) {}

  async rows({ userId }: PersonalDataSubject) {
    const [row] = await this.db
      .select()
      .from(userAvatars)
      .where(eq(userAvatars.userId, userId));
    return row
      ? [{ avatarUrl: avatarUrl(userId, row.key), updatedAt: row.updatedAt }]
      : [];
  }

  async erase({ userId }: PersonalDataSubject) {
    await this.db.delete(userAvatars).where(eq(userAvatars.userId, userId));
    try {
      const keys: string[] = [];
      for await (const entry of this.disk.listAll({
        prefix: accountFileKey(userId, 'avatar/'),
      })) {
        keys.push(entry.key);
      }
      if (keys.length > 0) await this.disk.delete(keys);
    } catch (error) {
      this.logger.warn("A deleted account's pictures were not deleted", {
        userId,
        error: String(error),
      });
    }
  }
}

/** `avatarUrl` of who-am-I (`GET /v1/auth/me`): the picture's address, or null for none. */
@WhoAmIPart(['avatarUrl'])
@Injectable()
export class AvatarsWhoAmI implements WhoAmIProvider {
  constructor(private readonly avatars: AvatarsService) {}

  async whoAmI({ user }: WhoAmIRequest) {
    return { avatarUrl: await this.avatars.urlOf(user.id) };
  }
}
