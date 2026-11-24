import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { closeRedis, REDIS } from '../../core/redis/redis.js';
import { currentTenantScope } from '../../core/tenancy/tenant-scope.js';
import { SettingsRepository } from './settings.repository.js';
import { platformSettingValues, settingOverrides } from './settings.tables.js';

/** A stored override with its secret opened: what the cache holds and the service reads. */
export type OverrideRow = typeof settingOverrides.$inferSelect;
export type PlatformRow = typeof platformSettingValues.$inferSelect;

interface Entry<T> {
  value: T;
  loadedAt: number;
}

/** What a message on the channel invalidates: a tenant's id, or the platform values. */
const PLATFORM = 'platform';

/**
 * What the settings service reads: the current tenant's overrides by key and
 * the platform values, each kept in memory per instance. A change calls
 * `invalidate()` after its commit: this instance forgets at once, the others
 * on a Redis pub/sub message (as AccessService does for abilities), so a
 * change applies from the next request everywhere, and only that tenant's
 * cache reloads. A message lost (Redis away) leaves an entry for MAX_AGE_MS
 * at most. Reads never wait for Redis.
 */
@Injectable()
export class SettingsCache implements OnModuleInit, OnApplicationShutdown {
  private static readonly MAX_AGE_MS = 60_000;
  private static readonly MAX_TENANTS = 1_000;
  private readonly logger = new Logger(SettingsCache.name);
  /** This instance, so it ignores its own messages coming back. */
  private readonly instanceId = randomUUID();
  /** Bumped by every invalidation: a load that began before one is not stored. */
  private generation = 0;
  private subscriber?: Redis;
  /** Per tenant, the least recently loaded first. */
  private readonly tenants = new Map<
    string,
    Entry<Map<string, OverrideRow[]>>
  >();
  private platform?: Entry<Map<string, PlatformRow>>;
  private readonly platformListeners: (() => void)[] = [];

  constructor(
    private readonly repository: SettingsRepository,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly encryption: EncryptionService,
  ) {}

  /** Pub/sub channels ignore ioredis' key prefix: the prefix goes into the name. */
  private get channel() {
    return `${this.redis.options.keyPrefix ?? ''}settings:invalidate`;
  }

  async onModuleInit() {
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('message', (_channel: string, message: string) => {
      const [from, scope] = message.split(' ');
      if (from !== this.instanceId && scope) this.forget(scope);
    });
    await this.subscriber.subscribe(this.channel);
  }

  async onApplicationShutdown() {
    if (this.subscriber) await closeRedis(this.subscriber);
  }

  /**
   * Calls `listener` when the platform values change, here or on another
   * instance, so a cache of one (the app mode) needn't wait for its own expiry.
   */
  onPlatformChange(listener: () => void) {
    this.platformListeners.push(listener);
  }

  /** After a commit: forgets a tenant's overrides (or, with none, the platform values), here and everywhere. */
  invalidate(tenantId?: string) {
    const scope = tenantId ?? PLATFORM;
    this.forget(scope);
    void this.redis
      .publish(this.channel, `${this.instanceId} ${scope}`)
      .catch((error: unknown) =>
        this.logger.warn(
          `A settings change was not announced to the other instances (Redis: ${String(error)}); they serve the old value for up to ${SettingsCache.MAX_AGE_MS} ms.`,
        ),
      );
  }

  private forget(scope: string) {
    this.generation++;
    if (scope === PLATFORM) {
      this.platform = undefined;
      for (const listener of this.platformListeners) listener();
    } else {
      this.tenants.delete(scope);
    }
  }

  private fresh(entry: Entry<unknown> | undefined): entry is Entry<never> {
    return !!entry && Date.now() - entry.loadedAt < SettingsCache.MAX_AGE_MS;
  }

  /** The current tenant's overrides by key (none outside a tenant). */
  async overrides(): Promise<Map<string, OverrideRow[]>> {
    const tenantId = currentTenantScope()?.tenantId;
    if (!tenantId) return new Map();
    const cached = this.tenants.get(tenantId);
    if (this.fresh(cached)) return cached.value;
    const generation = this.generation;
    const rows = await this.repository.overrides();
    const byKey = new Map<string, OverrideRow[]>();
    for (const row of rows) {
      const opened = row.secret
        ? {
            ...row,
            value: this.encryption.decrypt(settingOverrides.secret, row.secret),
          }
        : row;
      byKey.set(row.key, [...(byKey.get(row.key) ?? []), opened]);
    }
    if (generation === this.generation) {
      this.tenants.delete(tenantId);
      this.tenants.set(tenantId, { value: byKey, loadedAt: Date.now() });
      if (this.tenants.size > SettingsCache.MAX_TENANTS) {
        this.tenants.delete(this.tenants.keys().next().value!);
      }
    }
    return byKey;
  }

  /** The platform values by key. */
  async platformValues(): Promise<Map<string, PlatformRow>> {
    if (this.fresh(this.platform)) return this.platform.value;
    const generation = this.generation;
    const rows = await this.repository.platformValues();
    const byKey = new Map(
      rows.map((row) => [
        row.key,
        row.secret
          ? {
              ...row,
              value: this.encryption.decrypt(
                platformSettingValues.secret,
                row.secret,
              ),
            }
          : row,
      ]),
    );
    if (generation === this.generation) {
      this.platform = { value: byKey, loadedAt: Date.now() };
    }
    return byKey;
  }
}
