import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../../core/database/database.js';
import {
  WhoAmIPart,
  type WhoAmIProvider,
  type WhoAmIRequest,
} from '../../../iam/auth/who-am-i.js';
import { MemberAvatars } from '../../../iam/access/member-avatars.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../../iam/personal-data/personal-data.js';
import { AvatarsService, avatarUrl } from './avatars.service.js';
import { userAvatars } from './avatars.tables.js';

/**
 * The person's picture: its address in their export. With their account the
 * row goes; the files go with every other file under `accounts/<id>/`
 * (modules/storage's `account-files` section, after the erase commits).
 */
@PersonalData({ name: 'avatar', scopes: ['account'] })
@Injectable()
export class AvatarsPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

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
  }
}

/** `avatarUrl` of who-am-I (`GET /v1/auth/me`): the picture's address, or null for none. */
@WhoAmIPart({
  avatarUrl: z
    .string()
    .nullable()
    .describe('Your picture (`GET /v1/people/{id}/avatar?v=…`); null: none.'),
})
@Injectable()
export class AvatarsWhoAmI implements WhoAmIProvider {
  constructor(private readonly avatars: AvatarsService) {}

  async whoAmI({ user }: WhoAmIRequest) {
    return { avatarUrl: await this.avatars.urlOf(user.id) };
  }
}

/** The members' pictures in the access API's users (`avatarUrl`). */
@MemberAvatars()
@Injectable()
export class AvatarsMembers implements MemberAvatars {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async avatarUrls(userIds: readonly string[]) {
    const rows = await this.db
      .select({ userId: userAvatars.userId, key: userAvatars.key })
      .from(userAvatars)
      .where(inArray(userAvatars.userId, [...userIds]));
    return new Map(
      rows.map((row) => [row.userId, avatarUrl(row.userId, row.key)]),
    );
  }
}
