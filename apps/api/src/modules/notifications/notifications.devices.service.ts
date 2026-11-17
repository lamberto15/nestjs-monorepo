import { InjectTransaction, Transactional } from '@nestjs-cls/transactional';
import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { EncryptedColumns } from '../../core/encryption/encrypted-columns.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import type { RegisterDeviceDto } from './notifications.schemas.js';
import { pushDevices } from './notifications.tables.js';

type Row = typeof pushDevices.$inferSelect;

const view = (row: Row) => ({
  id: row.id,
  name: row.name,
  lastSeenAt: row.lastSeenAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});

/**
 * The browsers a user registered for web push. Nothing here returns the
 * subscription: the endpoint and keys only go to the push service. The `auth`
 * secret is encrypted at rest. Registering and removing are audited
 * (`device.registered`, `device.removed`).
 */
@EncryptedColumns([pushDevices.auth])
@Injectable()
export class DevicesService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Registers a browser, or refreshes it (the app calls this when it opens:
   * the last-seen time moves). A subscription another person had moves to the
   * caller: a browser belongs to whoever is signed in on it.
   */
  @Transactional()
  async register(user: UserPrincipal, dto: RegisterDeviceDto, ip?: string) {
    const { endpoint, keys } = dto.subscription;
    const values = {
      userId: user.id,
      name: dto.name,
      p256dh: keys.p256dh,
      auth: this.encryption.encrypt(pushDevices.auth, keys.auth),
      lastSeenAt: new Date(),
    };
    const [row] = await this.db
      .insert(pushDevices)
      .values({ ...values, endpoint })
      .onConflictDoUpdate({ target: pushDevices.endpoint, set: values })
      .returning();
    await this.audit.record(user, {
      action: 'device.registered',
      targetType: 'device',
      targetId: row!.id,
      details: { name: dto.name },
      ip,
    });
    return view(row!);
  }

  async list(user: UserPrincipal) {
    const rows = await this.db
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.userId, user.id))
      .orderBy(pushDevices.createdAt);
    return { items: rows.map(view) };
  }

  @Transactional()
  async remove(user: UserPrincipal, id: string, ip?: string) {
    const [row] = await this.db
      .delete(pushDevices)
      .where(and(eq(pushDevices.id, id), eq(pushDevices.userId, user.id)))
      .returning({ id: pushDevices.id, name: pushDevices.name });
    if (!row) throw new NotFoundException(`Device ${id} not found.`);
    await this.audit.record(user, {
      action: 'device.removed',
      targetType: 'device',
      targetId: id,
      details: { name: row.name },
      ip,
    });
  }

  /** A user's devices with their keys, for sending. */
  async forSending(userId: string) {
    const rows = await this.db
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.userId, userId));
    return rows.map((row) => this.subscription(row));
  }

  /** One device with its keys, or undefined (removed since the job was queued). */
  async find(id: string) {
    const [row] = await this.db
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.id, id));
    return row && this.subscription(row);
  }

  /** The push service says this browser is gone: forget it. */
  async forget(id: string) {
    await this.db.delete(pushDevices).where(eq(pushDevices.id, id));
  }

  /** Forgets browsers not seen since `before`; how many. */
  async sweep(before: Date) {
    const deleted = await this.db
      .delete(pushDevices)
      .where(lt(pushDevices.lastSeenAt, before))
      .returning({ id: pushDevices.id });
    return deleted.length;
  }

  private subscription(row: Row) {
    return {
      id: row.id,
      endpoint: row.endpoint,
      keys: {
        p256dh: row.p256dh,
        auth: this.encryption.decrypt(pushDevices.auth, row.auth),
      },
    };
  }
}
