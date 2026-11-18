import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { normalizers } from '../../core/encryption/data-cipher.js';
import { EncryptedColumns } from '../../core/encryption/encrypted-columns.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { REDIS } from '../../core/redis/redis.js';
import { withTenant } from '../../core/tenancy/tenant-job.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { MessagingLimits } from './messaging-limits.service.js';
import { messagingConfig } from './messaging.config.js';
import { MESSAGING_INBOUND_JOB } from './messaging.permissions.js';
import { allowedPrefix, maskPhone } from './messaging.policy.js';
import { MESSAGING } from './messaging.queue.js';
import type { DeviceView, PhoneView } from './messaging.schemas.js';
import {
  type DevicePlatform,
  messagingDevices as devices,
  phoneNumbers,
} from './messaging.tables.js';

const CODE_TTL_SECONDS = 10 * 60;
const CODE_MAX_ATTEMPTS = 5;

const view = (row: typeof devices.$inferSelect): DeviceView => ({
  id: row.id,
  platform: row.platform,
  name: row.name,
  lastSeenAt: row.lastSeenAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});

/**
 * A person's mobile devices and phone number: registered by them, used by
 * the push and SMS senders, removed with them. Tokens and numbers are
 * personal data, encrypted with a blind index; nothing here returns a token,
 * and the number only masked.
 */
@EncryptedColumns([devices.token, phoneNumbers.phone])
@Injectable()
export class MessagingService {
  private readonly logger = new Logger('Messaging');

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    @Inject(messagingConfig.KEY)
    private readonly config: ConfigType<typeof messagingConfig>,
    private readonly system: SystemContext,
    private readonly limits: MessagingLimits,
    @InjectQueue(MESSAGING) private readonly queue: Queue,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ---- devices ----

  /**
   * Registers a device, or refreshes it: the same token again (the app
   * opening) updates its name and last-seen time; a token another person had
   * registered moves to the caller (a shared browser: whoever registered it
   * last is who it belongs to).
   */
  async registerDevice(
    user: UserPrincipal,
    input: { platform: DevicePlatform; name: string; token: string },
    ip?: string,
  ): Promise<DeviceView> {
    return this.txHost.withTransaction(async () => {
      const [existing] = await this.db
        .select()
        .from(devices)
        .where(this.encryption.lookup(devices.token, input.token));
      const values = {
        userId: user.id,
        platform: input.platform,
        name: input.name,
        lastSeenAt: new Date(),
      };
      const row = existing
        ? (
            await this.db
              .update(devices)
              .set({
                ...values,
                // Re-sealed: a token indexed under an older key moves to the current one.
                ...this.encryption.seal(devices.token, input.token),
              })
              .where(eq(devices.id, existing.id))
              .returning()
          )[0]!
        : (
            await this.db
              .insert(devices)
              .values({
                ...values,
                ...(this.encryption.seal(devices.token, input.token) as {
                  token: string;
                  tokenIndex: string;
                }),
              })
              .returning()
          )[0]!;
      if (!existing || existing.userId !== user.id) {
        await this.audit.record(user, {
          action: 'device.registered',
          targetType: 'device',
          targetId: row.id,
          details: { platform: input.platform },
          ip,
        });
      }
      return view(row);
    });
  }

  async devicesOf(user: UserPrincipal): Promise<DeviceView[]> {
    const rows = await this.db
      .select()
      .from(devices)
      .where(eq(devices.userId, user.id))
      .orderBy(devices.createdAt);
    return rows.map(view);
  }

  /** Removes one of the caller's devices: its token is deleted, not kept revoked. */
  async removeDevice(user: UserPrincipal, id: string, ip?: string) {
    await this.txHost.withTransaction(async () => {
      const removed = await this.db
        .delete(devices)
        .where(and(eq(devices.id, id), eq(devices.userId, user.id)))
        .returning({ id: devices.id });
      if (!removed.length) {
        throw new NotFoundException('No such device.');
      }
      await this.audit.record(user, {
        action: 'device.removed',
        targetType: 'device',
        targetId: id,
        ip,
      });
    });
  }

  /** The decrypted token of a device, for the worker; undefined when it is gone. */
  async deviceToken(deviceId: string) {
    const [row] = await this.db
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId));
    return row
      ? {
          platform: row.platform,
          token: this.encryption.decrypt(devices.token, row.token),
        }
      : undefined;
  }

  /** The provider reported the token dead (or the device is otherwise gone). */
  async dropDevice(deviceId: string) {
    await this.db.delete(devices).where(eq(devices.id, deviceId));
  }

  /** The ids of the user's devices that can get a push now. */
  async deviceIdsOf(userId: string) {
    const rows = await this.db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.userId, userId));
    return rows.map((row) => row.id);
  }

  // ---- the phone number ----

  async phoneOf(user: UserPrincipal): Promise<PhoneView> {
    const [row] = await this.db
      .select()
      .from(phoneNumbers)
      .where(eq(phoneNumbers.userId, user.id));
    return row
      ? {
          phone: maskPhone(
            this.encryption.decrypt(phoneNumbers.phone, row.phone)!,
          ),
          verified: row.verifiedAt !== null,
          optedOut: row.optedOutAt !== null,
        }
      : { phone: null, verified: false, optedOut: false };
  }

  /**
   * Sets the caller's number and queues a verification code to it. A number
   * outside the allowed prefixes is refused here (a 400) as well as before
   * each send. The same number again keeps its state; a different one starts
   * unverified and not opted out.
   */
  async setPhone(user: UserPrincipal, phone: string, ip?: string) {
    let normalized: string;
    try {
      normalized = normalizers.phone(phone);
    } catch {
      throw new BadRequestException({
        code: 'phone_invalid',
        message: 'A phone number needs its country code (+4930123456).',
        errors: [{ path: 'phone', message: 'Not a valid phone number.' }],
      });
    }
    if (!allowedPrefix(normalized, this.config.sms.allowedPrefixes)) {
      throw new BadRequestException({
        code: 'phone_country_not_allowed',
        message: 'SMS is not available to that country.',
        errors: [{ path: 'phone', message: 'Country not supported.' }],
      });
    }
    // Per client IP, a day's codes are capped on top of the route's throttle.
    if (ip && !(await this.limits.reserveIp(ip))) {
      throw new HttpException(
        {
          code: 'sms_ip_limit',
          message:
            'Too many verification codes were requested from your network today.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.txHost.withTransaction(async () => {
      const [existing] = await this.db
        .select()
        .from(phoneNumbers)
        .where(eq(phoneNumbers.userId, user.id));
      const same =
        existing &&
        this.encryption.decrypt(phoneNumbers.phone, existing.phone) ===
          normalized;
      if (!same) {
        const sealed = this.encryption.seal(phoneNumbers.phone, normalized) as {
          phone: string;
          phoneIndex: string;
        };
        await this.db
          .insert(phoneNumbers)
          .values({ userId: user.id, ...sealed })
          .onConflictDoUpdate({
            target: phoneNumbers.userId,
            set: { ...sealed, verifiedAt: null, optedOutAt: null },
          });
        await this.audit.record(user, {
          action: 'phone.set',
          targetType: 'user',
          targetId: user.id,
          ip,
        });
      }
    });
    await this.redis.del(this.codeKey(user.id));
    await this.queue.add(
      'code',
      withTenant({ kind: 'code' as const, userId: user.id }),
      { attempts: 3 },
    );
    return this.phoneOf(user);
  }

  async removePhone(user: UserPrincipal, ip?: string) {
    await this.txHost.withTransaction(async () => {
      const removed = await this.db
        .delete(phoneNumbers)
        .where(eq(phoneNumbers.userId, user.id))
        .returning({ id: phoneNumbers.id });
      if (removed.length) {
        await this.audit.record(user, {
          action: 'phone.removed',
          targetType: 'user',
          targetId: user.id,
          ip,
        });
      }
    });
    await this.redis.del(this.codeKey(user.id));
  }

  /** Drops a code still waiting for the user (their account is deleted). */
  async forgetCode(userId: string) {
    await this.redis.del(this.codeKey(userId));
  }

  // ---- verification ----

  private codeKey(userId: string) {
    return `messaging:code:${userId}`;
  }

  private hash(userId: string, code: string) {
    return createHash('sha256').update(`${userId}:${code}`).digest('hex');
  }

  /** A new six-digit code for the user, kept hashed for ten minutes; the worker texts it. */
  async issueCode(userId: string) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.redis.set(
      this.codeKey(userId),
      JSON.stringify({ hash: this.hash(userId, code), attempts: 0 }),
      'EX',
      CODE_TTL_SECONDS,
    );
    return code;
  }

  /** Verifies the code the user received: five wrong guesses and it is void. */
  async verifyPhone(user: UserPrincipal, code: string, ip?: string) {
    const raw = await this.redis.get(this.codeKey(user.id));
    const stored = raw
      ? (JSON.parse(raw) as { hash: string; attempts: number })
      : null;
    const fail = () =>
      new BadRequestException({
        code: 'code_invalid',
        message: 'The code is wrong or has expired.',
        errors: [{ path: 'code', message: 'Wrong or expired.' }],
      });
    if (!stored) throw fail();
    const given = Buffer.from(this.hash(user.id, code));
    const expected = Buffer.from(stored.hash);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      if (stored.attempts + 1 >= CODE_MAX_ATTEMPTS) {
        await this.redis.del(this.codeKey(user.id));
      } else {
        await this.redis.set(
          this.codeKey(user.id),
          JSON.stringify({ ...stored, attempts: stored.attempts + 1 }),
          'KEEPTTL',
        );
      }
      throw fail();
    }
    await this.redis.del(this.codeKey(user.id));
    await this.txHost.withTransaction(async () => {
      const verified = await this.db
        .update(phoneNumbers)
        .set({ verifiedAt: new Date() })
        .where(eq(phoneNumbers.userId, user.id))
        .returning({ id: phoneNumbers.id });
      if (!verified.length) {
        throw new NotFoundException('Set a phone number first.');
      }
      await this.audit.record(user, {
        action: 'phone.verified',
        targetType: 'user',
        targetId: user.id,
        ip,
      });
    });
    return this.phoneOf(user);
  }

  /**
   * The user's number when SMS may go to it: verified and not opted out.
   * Decrypted; for the worker. `unverified`: the verification code goes to
   * a number not yet verified (but never to one that opted out).
   */
  async sendablePhone(
    userId: string,
    unverified = false,
  ): Promise<string | undefined> {
    const [row] = await this.db
      .select()
      .from(phoneNumbers)
      .where(
        and(eq(phoneNumbers.userId, userId), isNull(phoneNumbers.optedOutAt)),
      );
    if (!row || (!row.verifiedAt && !unverified)) return undefined;
    return this.encryption.decrypt(phoneNumbers.phone, row.phone) ?? undefined;
  }

  /** Whether the user has a number SMS may go to (the channel's cheap check; no decryption). */
  async hasSendablePhone(userId: string) {
    const [row] = await this.db
      .select({ verifiedAt: phoneNumbers.verifiedAt })
      .from(phoneNumbers)
      .where(
        and(eq(phoneNumbers.userId, userId), isNull(phoneNumbers.optedOutAt)),
      );
    return row?.verifiedAt != null;
  }

  // ---- STOP and START ----

  /**
   * A number replied STOP (or the provider says it opted out): every user
   * with that number is opted out, whichever tenant they are in. Returns how
   * many. START undoes only that: `optIn` re-enables a number that opted
   * out, and does nothing for one that was never set up or verified.
   */
  optOut(phone: string, source: string) {
    return this.setOptOut(phone, source, true);
  }

  optIn(phone: string, source: string) {
    return this.setOptOut(phone, source, false);
  }

  private async setOptOut(phone: string, source: string, out: boolean) {
    let normalized: string;
    try {
      normalized = normalizers.phone(phone);
    } catch {
      return 0; // not a number we could have stored
    }
    return this.system.run(
      MESSAGING_INBOUND_JOB,
      async (system) => {
        const rows = await this.db
          .select({
            id: phoneNumbers.id,
            userId: phoneNumbers.userId,
            optedOutAt: phoneNumbers.optedOutAt,
          })
          .from(phoneNumbers)
          .where(this.encryption.lookup(phoneNumbers.phone, normalized));
        const changing = rows.filter((row) =>
          out ? row.optedOutAt === null : row.optedOutAt !== null,
        );
        for (const row of changing) {
          await this.db
            .update(phoneNumbers)
            .set({ optedOutAt: out ? new Date() : null })
            .where(eq(phoneNumbers.id, row.id));
          await this.audit.record(system, {
            action: out ? 'phone.optedOut' : 'phone.optedIn',
            targetType: 'user',
            targetId: row.userId,
            details: { source },
          });
        }
        if (changing.length) {
          this.logger.log(out ? 'Number opted out' : 'Number opted back in', {
            source,
            users: changing.length,
          });
        }
        return changing.length;
      },
      { tenantId: null },
    );
  }

  /** Devices not seen since `before`: what the nightly job removes. */
  async removeStaleDevices(before: Date) {
    const removed = await this.db
      .delete(devices)
      .where(lt(devices.lastSeenAt, before))
      .returning({ id: devices.id });
    return removed.length;
  }
}
