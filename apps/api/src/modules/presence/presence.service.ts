import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../core/redis/redis.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import {
  principalKey,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import { Realtime } from '../realtime/realtime.service.js';
import { recordPresence } from './presence.events.js';
import { PresenceRecords } from './presence.records.js';
import {
  MAX_PRESENT,
  PRESENCE_TTL_SECONDS,
  type PresenceMode,
  type PresenceRecord,
} from './presence.schemas.js';

interface Entry {
  name: string;
  mode: PresenceMode;
  /** Epoch ms: the hash's TTL is the latest beat's, so each entry carries its own. */
  until: number;
}

/**
 * Who is viewing or editing a record now: ephemeral and advisory. Each page
 * beats every few seconds; an entry lives PRESENCE_TTL_SECONDS in Redis (a
 * hash per tenant and record, a field per principal), so a closed tab or a
 * lost connection drops out by itself. Only the mode is kept (and the name,
 * to show), never what is being typed. Everything needs the caller to read
 * the record (PresenceRecords). Others hear of a change as a
 * `record.presence` event (ids only) and fetch the list. Saving is still
 * guarded by the record's ETag. Redis down: no presence, nothing else breaks.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger('Presence');

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly records: PresenceRecords,
    private readonly realtime: Realtime,
  ) {}

  async list(user: RequestPrincipal, record: PresenceRecord) {
    await this.records.assertReads(user, record);
    return this.present(user, await this.entries(record));
  }

  /** The caller is on the record in this mode: refreshes their entry, returns the list. */
  async beat(
    user: RequestPrincipal,
    record: PresenceRecord,
    mode: PresenceMode,
  ) {
    await this.records.assertReads(user, record);
    const key = this.key(record);
    const self = principalKey(user);
    const before = await this.redis
      .hget(key, self)
      .then((value) => this.parse(value))
      .catch(() => undefined);
    const entry: Entry = {
      name: user.name,
      mode,
      until: Date.now() + PRESENCE_TTL_SECONDS * 1000,
    };
    try {
      await this.redis
        .multi()
        .hset(key, self, JSON.stringify(entry))
        .expire(key, PRESENCE_TTL_SECONDS)
        .exec();
    } catch (error) {
      this.logger.warn(`Presence not kept: ${String(error)}`);
    }
    const live = await this.entries(record);
    // Others hear of a new arrival or a changed mode, not of every beat.
    if (before?.mode !== mode) {
      this.announce(record, live, self);
    }
    return this.present(user, live);
  }

  async leave(user: RequestPrincipal, record: PresenceRecord) {
    await this.records.assertReads(user, record);
    const self = principalKey(user);
    try {
      await this.redis.hdel(this.key(record), self);
    } catch (error) {
      this.logger.warn(`Presence not removed: ${String(error)}`);
    }
    this.announce(record, await this.entries(record), self);
  }

  /** In the tenant's hash: a record's id is unique in its tenant only. */
  private key(record: PresenceRecord) {
    return `presence:${requireTenantId('Presence')}:${record.subject}:${record.recordId}`;
  }

  private parse(value: string | null): Entry | undefined {
    if (!value) {
      return undefined;
    }
    const entry = JSON.parse(value) as Entry;
    return entry.until > Date.now() ? entry : undefined;
  }

  /** The live entries of a record by principal key; expired ones are deleted. */
  private async entries(record: PresenceRecord) {
    const live = new Map<string, Entry>();
    try {
      const all = await this.redis.hgetall(this.key(record));
      const expired: string[] = [];
      for (const [key, value] of Object.entries(all)) {
        const entry = this.parse(value);
        if (entry) {
          live.set(key, entry);
        } else {
          expired.push(key);
        }
      }
      if (expired.length) {
        void this.redis.hdel(this.key(record), ...expired).catch(() => 0);
      }
    } catch (error) {
      this.logger.warn(`Presence not read: ${String(error)}`);
    }
    return live;
  }

  private present(user: RequestPrincipal, live: Map<string, Entry>) {
    const self = principalKey(user);
    return {
      items: [...live]
        .map(([key, { name, mode }]) => ({
          key,
          name,
          mode,
          self: key === self,
        }))
        .slice(0, MAX_PRESENT),
    };
  }

  /**
   * Tells the people on the record (and the one who changed, for their
   * other tabs) to fetch the list. They were allowed on it when they beat,
   * and an entry lasts under a minute: a revoked reader hears ids only,
   * once, before dropping out.
   */
  private announce(
    record: PresenceRecord,
    live: Map<string, Entry>,
    changed: string,
  ) {
    const refs = [...new Set([...live.keys(), changed])].map((key) => {
      const [kind, id] = key.split(':') as ['user' | 'client', string];
      return { kind, id };
    });
    this.realtime.toPrincipals(refs, recordPresence, {
      subject: record.subject,
      recordId: record.recordId,
    });
  }
}
