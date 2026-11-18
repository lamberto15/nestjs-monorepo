import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from '../../../iam/audit/audit.module.js';
import { avatarsConfig } from './avatars.config.js';
import {
  AvatarController,
  PeopleAvatarController,
} from './avatars.controller.js';
import { AvatarsService } from './avatars.service.js';
import { AvatarUpload } from './avatars.upload.js';
import {
  AvatarsMembers,
  AvatarsPersonalData,
  AvatarsWhoAmI,
} from './avatars.personal-data.js';

/**
 * Users' pictures (README.md): `PUT|DELETE /v1/account/avatar` and
 * `GET /v1/people/{id}/avatar`. A user's, not a record's, so it is not an
 * add-on: list it in app.module.ts beside AttachmentsModule. Needs
 * StorageModule. `AvatarsService.urlOf()` is what a module that lists people
 * asks for `avatarUrl`.
 */
@Module({
  imports: [ConfigModule.forFeature(avatarsConfig), AuditModule],
  controllers: [AvatarController, PeopleAvatarController],
  providers: [
    AvatarsService,
    AvatarUpload,
    AvatarsPersonalData,
    AvatarsWhoAmI,
    AvatarsMembers,
  ],
  exports: [AvatarsService],
})
export class AvatarsModule {}
