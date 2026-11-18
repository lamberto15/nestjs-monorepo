import { type DynamicModule, Injectable, Module } from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';
import type { RecordDeclaration, RecordRow } from '../records/record.js';
import {
  InjectRecord,
  RECORD,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import { RecordsModule } from '../records/records.module.js';
import { ViewsModule } from '../views/views.module.js';
import { FavoritesController } from './favorites.controller.js';
import { FavoritesRegistry } from './favorites.registry.js';
import { FavoritesService } from './favorites.service.js';
import { FavoritesPersonalData } from './favorites.personal-data.js';

/**
 * What favorites add to a record that can be pinned: `?include=favorite`
 * (the caller's favorite id for it, null when it is not one: what
 * DELETE /v1/favorites/{id} takes; outside the ETag, as it is the reader's),
 * and its favorites removed with it when it is deleted for good.
 */
@RecordExtension()
@Injectable()
export class FavoritesExtension implements RecordHooks {
  readonly include = {
    name: 'favorite',
    values: (principal: Principal, ids: string[]) =>
      this.favorites.favoriteIds(principal, this.record.subject, ids),
  };

  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly favorites: FavoritesService,
    registry: FavoritesRegistry,
  ) {
    registry.add(record.subject);
  }

  async purged({ ids }: { ids: readonly string[] }) {
    await this.favorites.forget(this.record.subject, ids);
  }

  async merged({ from, to }: { from: RecordRow; to: RecordRow }) {
    await this.favorites.merge(this.record.subject, from.id, to.id);
  }
}

/**
 * Favorites (README.md): the `/favorites` routes and service, shared by
 * every record that can be pinned. A feature's module imports
 * `FavoritesModule.forRecord(RECORD)` for each record.
 */
@Module({
  imports: [RecordsModule, ViewsModule],
  controllers: [FavoritesController],
  providers: [FavoritesService, FavoritesRegistry, FavoritesPersonalData],
  exports: [FavoritesService, FavoritesRegistry],
})
export class FavoritesModule {
  /** Favorites for one record: its extension (the subject may be pinned). */
  static forRecord(record: RecordDeclaration): DynamicModule {
    return {
      module: FavoritesRecordModule,
      imports: [RecordsModule, FavoritesModule],
      providers: [{ provide: RECORD, useValue: record }, FavoritesExtension],
    };
  }
}

/** The host of one `FavoritesModule.forRecord()`. */
@Module({})
class FavoritesRecordModule {}
