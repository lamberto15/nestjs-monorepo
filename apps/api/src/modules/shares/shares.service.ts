import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import { and, count, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { httpConfig } from '../../core/http/http.config.js';
import { MailQueue } from '../../core/mail/mail.queue.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import {
  normalizeEmail,
  UsersRepository,
} from '../../iam/auth/users.repository.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { Records } from '../records/records.service.js';
import {
  type CreateShareDto,
  MAX_SHARES_PER_RECORD,
  type OpenShareDto,
  SHARE_CODE_ATTEMPTS,
  SHARE_CODE_MINUTES,
  type ShareView,
} from './share.schemas.js';
import { sharesConfig } from './shares.config.js';
import { ShareCodeMail } from './shares.mail.js';
import { type RecordShareRow, recordShares } from './shares.tables.js';

/** The record's capability name: a record that imports `SharesModule.forRecord()` can be shared. */
export const SHARES_CAPABILITY = 'shares';

/** The action a record's permissions grant for sharing it (a link shows what its maker reads). */
export const SHARE_ACTION = 'share';

/** `shr_<tenant id>_<secret>`: the tenant, so the link is read in its scope. */
const TOKEN =
  /^shr_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;

const hashOf = (value: string) =>
  createHash('sha256').update(value).digest('base64url');

/** The code's hash, bound to its link: a code of one link opens no other. */
const codeHashOf = (shareId: string, code: string) =>
  hashOf(`${shareId}:${code}`);

/** Every refusal of a link: forged, expired, revoked, its record or maker gone. One answer, no oracle. */
const notFound = () =>
  new NotFoundException({
    code: 'share_not_found',
    message: t('shares.notFound'),
  });

/** A record a link is made for: its subject and id. */
interface RecordRef {
  subject: string;
  recordId: string;
}

/**
 * Read-only links to one record: a member who may share a record (its
 * subject's `share` action) makes a link that shows chosen fields of it to
 * whoever holds the link, or only to one address that proves its mailbox
 * with a mailed code, until it expires or is revoked.
 *
 * The link's token (`shr_<tenant>_<secret>`, 256 random bits) is shown
 * once; only its hash is kept. Opening it checks, every time: the link
 * (not revoked, not expired), its tenant (active), its maker (still an
 * active member) and the record (there, not in the recycle bin, and still
 * readable and shareable by the maker), and shows the shared fields as the
 * maker may read them now: a link never shows more than its maker sees,
 * never another record (no reference field is shared), and is no sign-in:
 * its holder is nobody in the tenant. Making, revoking and every opening
 * are audited; the token is never logged nor audited.
 */
@Injectable()
export class SharesService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly records: Records,
    private readonly attachments: AttachmentsService,
    private readonly access: AccessService,
    private readonly tenancy: Tenancy,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly mailQueue: MailQueue,
    @Inject(sharesConfig.KEY)
    private readonly config: ConfigType<typeof sharesConfig>,
    @Inject(httpConfig.KEY)
    private readonly http: Pick<ConfigType<typeof httpConfig>, 'webUrl'>,
  ) {}

  /** The fields a link may show: the record's declared fields, never a reference to another record. */
  fieldsOf(subject: string) {
    return Object.entries(this.records.of(subject).declaration.fields)
      .filter(([, field]) => field.kind !== 'ref')
      .map(([name]) => name);
  }

  /** Whether the subject's records take files (they import `AttachmentsModule.forRecord()`). */
  private takesFiles(subject: string) {
    return this.records
      .of(subject)
      .extensions.some((hooks) => hooks.capability === 'attachments');
  }

  /** A record's links, newest first (revoked and expired ones too): for who may share it. */
  async list(principal: RequestPrincipal, record: RecordRef) {
    await this.assertCanShare(principal, record);
    const rows = await this.db
      .select()
      .from(recordShares)
      .where(this.ofRecord(record))
      .orderBy(desc(recordShares.id));
    return { items: rows.map((row) => this.view(row)) };
  }

  /** A new link to the record: its token is in this answer only. */
  async create(
    principal: RequestPrincipal,
    record: RecordRef,
    dto: CreateShareDto,
    ip?: string,
  ) {
    if (principal.kind !== 'user') {
      // An API client is nobody to answer for a link a person opens.
      throw new ForbiddenException('Only a person shares a record by link.');
    }
    // An impersonating administrator would hand out what the user sees.
    if (principal.impersonator) {
      throw new ForbiddenException(t('auth.notWhileImpersonating'));
    }
    await this.assertCanShare(principal, record);
    const allowed = this.fieldsOf(record.subject);
    const fields = [...new Set(dto.fields)];
    const unknown = fields.filter((name) => !allowed.includes(name));
    if (unknown.length) {
      throw this.invalid(
        'fields',
        `Not fields a link shares: ${unknown.join(', ')}. Any of ${allowed.join(', ')}.`,
      );
    }
    if (dto.files && !this.takesFiles(record.subject)) {
      throw this.invalid('files', `${record.subject} records take no files.`);
    }
    const shown = await this.shared(principal, record, fields);
    const hidden = fields.filter((name) => !shown || !(name in shown));
    if (hidden.length) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `You may not read: ${hidden.join(', ')}.`,
        fields: hidden,
      });
    }
    const expiresAt = new Date(dto.expiresAt);
    const now = Date.now();
    if (
      expiresAt.getTime() <= now ||
      expiresAt.getTime() > now + this.config.maxDays * 86_400_000
    ) {
      throw this.invalid(
        'expiresAt',
        `In the future, within ${this.config.maxDays} days.`,
      );
    }
    const tenantId = this.tenancy.tenantId();
    const token = `shr_${tenantId}_${randomBytes(32).toString('base64url')}`;
    const row = await this.txHost.withTransaction(async () => {
      const [{ open }] = await this.db
        .select({ open: count() })
        .from(recordShares)
        .where(and(this.ofRecord(record), this.working()));
      if (open! >= MAX_SHARES_PER_RECORD) {
        throw new BadRequestException(
          `At most ${MAX_SHARES_PER_RECORD} working links per record: revoke one first.`,
        );
      }
      const [created] = await this.db
        .insert(recordShares)
        .values({
          subject: record.subject,
          recordId: record.recordId,
          fields,
          files: dto.files,
          tokenHash: hashOf(token),
          recipientEmail: dto.recipientEmail
            ? normalizeEmail(dto.recipientEmail)
            : null,
          createdBy: principalKey(principal),
          expiresAt,
        })
        .returning();
      await this.audit.record(principal, {
        action: 'share.created',
        targetType: 'share',
        targetId: created!.id,
        details: {
          subject: record.subject,
          recordId: record.recordId,
          fields,
          files: dto.files,
          recipientEmail: created!.recipientEmail,
          expiresAt: expiresAt.toISOString(),
        },
        ip,
      });
      return created!;
    });
    return {
      ...this.view(row),
      token,
      url: `${this.http.webUrl}/shared#${token}`,
    };
  }

  /**
   * Revokes a link at once: its maker, or anyone who may share the record.
   * Revoking a revoked one changes nothing.
   */
  async revoke(
    principal: RequestPrincipal,
    record: RecordRef,
    id: string,
    ip?: string,
  ) {
    const [row] = await this.db
      .select()
      .from(recordShares)
      .where(and(eq(recordShares.id, id), this.ofRecord(record)));
    if (!row) throw new NotFoundException(`Share ${id} not found.`);
    if (row.createdBy !== principalKey(principal)) {
      await this.assertCanShare(principal, record);
    }
    if (row.revokedAt) return;
    await this.txHost.withTransaction(async () => {
      await this.db
        .update(recordShares)
        .set({ revokedAt: new Date(), revokedBy: principalKey(principal) })
        .where(and(eq(recordShares.id, id), isNull(recordShares.revokedAt)));
      await this.audit.record(principal, {
        action: 'share.revoked',
        targetType: 'share',
        targetId: id,
        details: { subject: row.subject, recordId: row.recordId },
        ip,
      });
    });
  }

  /** What a link shows, as its maker may read it now; audited `share.opened`. */
  async open(dto: OpenShareDto, ip?: string) {
    return this.inTenantOf(dto.token, async (share, maker) => {
      await this.assertCode(share, dto.code);
      const fields = await this.shared(maker, share, share.fields);
      if (!fields) throw notFound();
      const files =
        share.files && this.takesFiles(share.subject)
          ? await this.attachments.sharedFiles(maker, share, share.fields)
          : [];
      await this.txHost.withTransaction(async () => {
        await this.db
          .update(recordShares)
          .set({
            views: sql`${recordShares.views} + 1`,
            lastViewedAt: new Date(),
          })
          .where(eq(recordShares.id, share.id));
        await this.opened(share, ip);
      });
      return {
        subject: share.subject,
        fields,
        files,
        expiresAt: share.expiresAt.toISOString(),
      };
    });
  }

  /**
   * A signed download link to one of the shared files (5 minutes, as any
   * download link), handed out only while the link works: revoking it
   * stops new file links at once. Audited `share.opened` with the file.
   */
  async fileLink(dto: OpenShareDto, attachmentId: string, ip?: string) {
    return this.inTenantOf(dto.token, async (share, maker) => {
      await this.assertCode(share, dto.code);
      if (!share.files || !this.takesFiles(share.subject)) {
        throw new NotFoundException(`Attachment ${attachmentId} not found.`);
      }
      if (!(await this.shared(maker, share, share.fields))) throw notFound();
      const link = await this.attachments.sharedDownload(
        maker,
        share,
        share.fields,
        attachmentId,
      );
      await this.txHost.withTransaction(() =>
        this.opened(share, ip, attachmentId),
      );
      return link;
    });
  }

  /** The audit entry of an opening: who holds the link is nobody in the tenant. */
  private opened(share: RecordShareRow, ip?: string, attachmentId?: string) {
    return this.audit.recordAnonymous(share.recipientEmail ?? 'Share link', {
      action: 'share.opened',
      targetType: 'share',
      targetId: share.id,
      details: {
        subject: share.subject,
        recordId: share.recordId,
        ...(attachmentId && { attachmentId }),
      },
      ip,
    });
  }

  /**
   * Mails a new code to the link's recipient (the last one stops working).
   * Answers the same whether or not the link has a recipient.
   */
  async sendCode(token: string) {
    await this.inTenantOf(token, async (share) => {
      if (!share.recipientEmail) return;
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      await this.db
        .update(recordShares)
        .set({
          codeHash: codeHashOf(share.id, code),
          codeExpiresAt: new Date(Date.now() + SHARE_CODE_MINUTES * 60_000),
          codeAttempts: 0,
        })
        .where(eq(recordShares.id, share.id));
      await this.mailQueue.send(ShareCodeMail, {
        to: share.recipientEmail,
        data: { code, minutes: SHARE_CODE_MINUTES },
      });
    });
  }

  /** When records are gone for good: their links too. */
  async forget(subject: string, recordIds: readonly string[]) {
    await this.db
      .delete(recordShares)
      .where(
        and(
          eq(recordShares.subject, subject),
          inArray(recordShares.recordId, [...recordIds]),
        ),
      );
  }

  /**
   * The record's `fields`, as reading it shows them to `principal`
   * (field-level permissions: a field they may not read is left out), or
   * null when it is gone (or in the recycle bin) or they may no longer read
   * or share it.
   */
  private async shared(
    principal: Principal,
    { subject, recordId }: RecordRef,
    fields: readonly string[],
  ) {
    const { store, presenter } = this.records.of(subject);
    const row = await store
      .findOne(recordId, { visibleTo: principal })
      .catch((error: unknown) => {
        if (error instanceof NotFoundException) return null;
        throw error;
      });
    if (
      !row ||
      !(await this.access.can(principal, SHARE_ACTION, subject, row))
    ) {
      return null;
    }
    const view = await presenter.one(principal, row);
    return Object.fromEntries(
      fields.filter((name) => name in view).map((name) => [name, view[name]]),
    );
  }

  /** A 404 when the record doesn't exist or they may not read it, a 403 when they read but may not share it. */
  private async assertCanShare(
    principal: Principal,
    { subject, recordId }: RecordRef,
  ) {
    const { store } = this.records.of(subject);
    const row = await store.findOne(recordId, { visibleTo: principal });
    if (!(await this.access.can(principal, SHARE_ACTION, subject, row))) {
      throw new ForbiddenException(`You may not share ${subject} ${recordId}.`);
    }
  }

  /**
   * Runs `work` in the link's tenant with the working link and its maker
   * as they are now; every refusal the one 404.
   */
  private async inTenantOf<T>(
    token: string,
    work: (share: RecordShareRow, maker: Principal) => Promise<T>,
  ) {
    const tenantId = TOKEN.exec(token)?.[1];
    if (!tenantId) throw notFound();
    const tenant = await this.tenancy.find(tenantId);
    if (!tenant?.active) throw notFound();
    return this.tenancy.run(tenantId, async () => {
      const [share] = await this.db
        .select()
        .from(recordShares)
        .where(and(eq(recordShares.tokenHash, hashOf(token)), this.working()));
      if (
        !share ||
        !share.createdBy.startsWith('user:') ||
        !this.records.find(share.subject)
      ) {
        throw notFound();
      }
      // The maker as they are now: an ended membership ends their links.
      const maker = await this.users.inTenant(
        share.createdBy.slice('user:'.length),
        tenantId,
      );
      if (!maker || maker.tenantId !== tenantId) throw notFound();
      return work(share, maker);
    });
  }

  /**
   * A link to a recipient opens with the code last mailed to them, before
   * it ends and within its tries; a wrong code spends one (committed
   * before the 403).
   */
  private async assertCode(share: RecordShareRow, code: string | undefined) {
    if (!share.recipientEmail) return;
    if (!code) {
      throw new ForbiddenException({
        code: 'share_code_required',
        message: 'This link opens with the code mailed to its recipient.',
      });
    }
    const given = Buffer.from(codeHashOf(share.id, code));
    const expected = Buffer.from(share.codeHash ?? '');
    const valid =
      share.codeExpiresAt !== null &&
      share.codeExpiresAt.getTime() > Date.now() &&
      share.codeAttempts < SHARE_CODE_ATTEMPTS &&
      given.length === expected.length &&
      timingSafeEqual(given, expected);
    if (!valid) {
      await this.db
        .update(recordShares)
        .set({ codeAttempts: sql`${recordShares.codeAttempts} + 1` })
        .where(eq(recordShares.id, share.id));
      throw new ForbiddenException({
        code: 'share_code_invalid',
        message: 'The code is wrong or has expired: ask for a new one.',
      });
    }
  }

  private invalid(path: string, message: string) {
    return new BadRequestException({
      code: 'validation_failed',
      message: 'The request is invalid.',
      errors: [{ path, message }],
    });
  }

  private ofRecord(record: RecordRef) {
    return and(
      eq(recordShares.subject, record.subject),
      eq(recordShares.recordId, record.recordId),
    );
  }

  /** Not revoked, not expired. */
  private working() {
    return and(
      isNull(recordShares.revokedAt),
      gt(recordShares.expiresAt, new Date()),
    );
  }

  private view(row: RecordShareRow): ShareView {
    return {
      id: row.id,
      subject: row.subject,
      recordId: row.recordId,
      fields: row.fields,
      files: row.files,
      recipientEmail: row.recipientEmail,
      createdBy: row.createdBy,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      active: !row.revokedAt && row.expiresAt.getTime() > Date.now(),
      views: row.views,
      lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
