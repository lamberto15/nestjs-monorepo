import { TransactionHost } from '@nestjs-cls/transactional';
import {
  Delete,
  HttpCode,
  HttpStatus,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can } from '@nestjs/authorization';
import {
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { z } from 'zod';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { publishSchemas } from '../../core/http/openapi.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { RecordDeclaration, RecordRow } from '../records/record.js';
import {
  InjectRecord,
  RecordController,
  RecordExtension,
  type RecordChange,
  type RecordHooks,
} from '../records/record-extension.js';
import { Records } from '../records/records.service.js';
import { notWhileImpersonating } from './notifications.principals.js';
import { defineNotifications } from './notifications.types.js';
import { SubscriptionsService } from './subscriptions.service.js';

/**
 * Past this many watched records changed in one transaction (a bulk edit),
 * the rest sum up: one notification per watcher, counted up, not one per record.
 */
export const BULK_THRESHOLD = 20;

/** The notifications a watched record sends: one type for every record (texts: i18n/en.json). */
export const RECORD_NOTIFICATIONS = defineNotifications([
  {
    // A watched record was changed by someone else: bundled in a daily mail by default.
    type: 'record.changed',
    email: 'daily',
    data: z.object({
      subject: z.string(),
      recordId: z.uuid(),
      noun: z.string(),
      title: z.string(),
      by: z.string(),
    }),
  },
  {
    // The same, past BULK_THRESHOLD records in one change: one summary per watcher.
    type: 'record.bulk-changed',
    email: 'daily',
    data: z.object({
      subject: z.string(),
      noun: z.string(),
      title: z.string(),
      by: z.string(),
    }),
  },
]);

const watchingSchema = z
  .object({ watching: z.boolean() })
  .meta({ id: 'Watching' });

// The record panels type their answers from it, with or without a feature.
publishSchemas('watching', watchingSchema);

/**
 * What watching adds to a record: its creator watches it from the start,
 * `?include=watching` says whether the reader does, whoever watches hears of
 * a change by someone else (past BULK_THRESHOLD records in one transaction,
 * a summary), and a record gone for good has no watchers.
 */
@RecordExtension()
@Injectable()
export class WatchingExtension implements RecordHooks {
  readonly capability = 'watch';
  readonly include = {
    name: 'watching',
    values: async (principal: Principal, ids: string[]) => {
      const watching = await this.subscriptions.watching(
        principal,
        this.record.subject,
        ids,
      );
      return new Map(ids.map((id) => [id, watching.has(id)]));
    },
  };
  /** Records notified so far in a transaction, to tell a bulk change from an edit. */
  private readonly changed = new WeakMap<object, number>();

  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly subscriptions: SubscriptionsService,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
  ) {}

  async created({ row }: RecordChange) {
    // The owner is a key (`user:<id>`): a system or unknown one watches nothing.
    const [kind, id] = row.ownerId.split(':');
    if ((kind === 'user' || kind === 'client') && id) {
      await this.subscriptions.subscribe(
        { kind, id },
        { subject: this.record.subject, recordId: row.id },
      );
    }
  }

  async updated({ after, by }: { after: RecordRow; by: Principal }) {
    const { subject } = this.record;
    const count = (this.changed.get(this.txHost.tx) ?? 0) + 1;
    this.changed.set(this.txHost.tx, count);
    const data = {
      subject,
      noun: this.record.noun,
      title: this.titleOf(after),
      by: by.name,
    };
    const bulk = count > BULK_THRESHOLD;
    await this.subscriptions.notifyWatchers({
      subject,
      recordId: after.id,
      type: bulk ? 'record.bulk-changed' : 'record.changed',
      data: bulk ? data : { ...data, recordId: after.id },
      // Repeated changes of a record collapse into one notification, counted up.
      key: bulk
        ? `record.bulk-changed:${subject}`
        : `record.changed:${after.id}`,
      link: `/${this.record.path}/${after.id}`,
      except: by,
    });
  }

  async purged({ ids }: { ids: readonly string[] }) {
    await this.subscriptions.forget(this.record.subject, ids);
  }

  async merged({ from, to }: { from: RecordRow; to: RecordRow }) {
    await this.subscriptions.merge(this.record.subject, from.id, to.id);
  }

  /** What the notification calls the record: its first text field, else its id. */
  private titleOf(row: RecordRow) {
    const name = Object.entries(this.record.fields).find(
      ([, field]) => (field as { kind: string }).kind === 'string',
    )?.[0];
    const title = name ? row[name] : undefined;
    return typeof title === 'string' && title ? title : row.id;
  }
}

/** `POST|DELETE /<path>/{id}/watch`: whoever may read the record watches it, and stops. */
export function watchRoutes(record: RecordDeclaration): Type {
  @RecordController(record, ':id/watch', 'Watch')
  class WatchRoutes {
    constructor(
      private readonly records: Records,
      private readonly subscriptions: SubscriptionsService,
      private readonly authorization: AuthorizationService,
    ) {}

    @Post()
    @HttpCode(HttpStatus.OK)
    @Can.Anyone() // Checked below: reading the record.
    @ApiOperation({
      summary: `Watch a ${record.noun}: be told when it changes`,
    })
    @ApiOkResponse({ standardSchema: watchingSchema })
    @ApiNotFoundResponse()
    async watch(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
    ) {
      notWhileImpersonating(user);
      const { store, feature } = this.records.of(record.subject);
      // Unreadable: the 404 of a missing one.
      const row = await store.findOne(id, { visibleTo: user });
      await this.authorization.authorize(
        feature.policy as unknown as Type<{
          read(...args: unknown[]): boolean;
        }>,
        'read',
        user,
        row,
      );
      await this.subscriptions.subscribe(user, {
        subject: record.subject,
        recordId: id,
      });
      return { watching: true };
    }

    @Delete()
    @HttpCode(HttpStatus.NO_CONTENT)
    @Can.Anyone() // Stopping needs nothing more than watching.
    @ApiOperation({ summary: `Stop watching a ${record.noun}` })
    @ApiNoContentResponse()
    @ApiNotFoundResponse({ description: 'You were not watching it.' })
    async unwatch(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
    ) {
      notWhileImpersonating(user);
      await this.subscriptions.remove(user, {
        subject: record.subject,
        recordId: id,
      });
    }
  }
  return WatchRoutes;
}
