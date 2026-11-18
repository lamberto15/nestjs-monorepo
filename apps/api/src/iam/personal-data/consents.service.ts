import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { t } from '@nestjs/i18n';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { CONSENT_KIND_PATTERN, ConsentKinds } from './consent-kinds.js';
import { consents } from './personal-data.tables.js';

type Consent = typeof consents.$inferSelect;

/**
 * What a person agreed to (README.md): every acceptance kept as proof, a
 * withdrawal as easy as giving it. Each change is one transaction with its
 * audit entry, in no tenant.
 */
@Injectable()
export class ConsentsService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly kinds: ConsentKinds,
  ) {}

  /** Each kind the person accepted, as its latest acceptance tells it. */
  async latest(userId: string) {
    const rows = await this.tenancy.run(null, () =>
      this.db
        .select()
        .from(consents)
        .where(eq(consents.userId, userId))
        .orderBy(desc(consents.acceptedAt), desc(consents.id)),
    );
    const byKind = new Map<string, Consent>();
    for (const row of rows) {
      if (!byKind.has(row.kind)) byKind.set(row.kind, row);
    }
    return [...byKind.values()].map(view);
  }

  /** Records an acceptance of a declared kind at its current version (else 400). */
  async accept(
    user: UserPrincipal,
    kind: string,
    version: string,
    ip?: string,
  ) {
    this.kinds.assertAcceptable(kind, version);
    const row = await this.inAccount(async () => {
      const [saved] = await this.db
        .insert(consents)
        .values({ userId: user.id, kind, version, ip })
        .returning();
      await this.audit.record(user, {
        action: 'account.consented',
        targetType: 'user',
        targetId: user.id,
        details: { kind, version },
        ip,
      });
      return saved!;
    });
    return view(row);
  }

  /**
   * Withdraws a consent: its acceptances in force are stamped, never
   * deleted. A required kind is refused (409 `consent_required`):
   * deleting the account ends it. Nothing in force: 404.
   */
  async withdraw(user: UserPrincipal, kind: string, ip?: string) {
    const notGiven = () =>
      new NotFoundException(t('personalData.consentNotGiven'));
    if (!CONSENT_KIND_PATTERN.test(kind)) {
      throw notGiven();
    }
    if (this.kinds.get(kind)?.required) {
      throw new ConflictException({
        code: 'consent_required',
        message: t('personalData.consentRequired'),
      });
    }
    const last = await this.inAccount(async () => {
      const withdrawn = await this.db
        .update(consents)
        .set({ withdrawnAt: new Date(), withdrawalIp: ip ?? null })
        .where(
          and(
            eq(consents.userId, user.id),
            eq(consents.kind, kind),
            isNull(consents.withdrawnAt),
          ),
        )
        .returning();
      if (withdrawn.length === 0) {
        throw notGiven();
      }
      const latest = withdrawn.reduce((a, b) =>
        b.acceptedAt > a.acceptedAt ? b : a,
      );
      await this.audit.record(user, {
        action: 'account.consent-withdrawn',
        targetType: 'user',
        targetId: user.id,
        details: { kind, version: latest.version },
        ip,
      });
      return latest;
    });
    return view(last);
  }

  private inAccount<T>(work: () => Promise<T>) {
    return this.tenancy.run(null, () => this.txHost.withTransaction(work));
  }
}

const view = (row: Consent) => ({
  kind: row.kind,
  version: row.version,
  acceptedAt: row.acceptedAt.toISOString(),
  withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
});
