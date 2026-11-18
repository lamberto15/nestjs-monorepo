import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { AvatarsModule } from '../attachments/avatars/avatars.module.js';
import {
  PeopleController,
  UnitDirectoryController,
} from './people.controller.js';
import { PeopleService } from './people.service.js';

/**
 * The directory of a tenant's people and units, for pickers and mentions
 * (README.md). Needs AuthModule (users, API clients) and the tenancy module.
 * PeopleService is exported for the modules that show who wrote what, and is
 * the `@ActorNameSource()` of the audit log. The avatars (and the storage
 * they need) come with it, for `avatarUrl`.
 */
@Module({
  imports: [StorageModule, AvatarsModule],
  controllers: [PeopleController, UnitDirectoryController],
  providers: [PeopleService],
  exports: [PeopleService],
})
export class PeopleModule {}
