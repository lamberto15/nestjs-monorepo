import { InjectTransaction, Transactional } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { users } from '../../iam/auth/auth.tables.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { SettingsService } from '../settings/settings.service.js';
import { ApprovalEngine } from './approval-engine.service.js';
import type { CreateDelegationDto } from './approvals.schemas.js';
import { APPROVAL_MAX_DELEGATION_DAYS } from './approvals.settings.js';
import {
  approvalDelegations,
  type ApprovalDelegationRow,
} from './approvals.tables.js';
import { activeMember } from './approvers.js';

/**
 * Out of office: a user lets another decide their approvals for a period
 * (every subject, or one). The delegate decides on the approver's
 * assignment, recorded as theirs `onBehalfOf` the approver; the approver
 * may still decide themselves. Users only, never while impersonating.
 */
@Injectable()
export class ApprovalDelegationsService {
  /** The newest this many a list shows (a person gives and holds a handful). */
  private static readonly LISTED = 200;

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly engine: ApprovalEngine,
  ) {}

  /** The caller's delegations, given and received, newest first. */
  async list(user: UserPrincipal) {
    const rows = await this.db
      .select()
      .from(approvalDelegations)
      .where(
        or(
          eq(approvalDelegations.fromUserId, user.id),
          eq(approvalDelegations.toUserId, user.id),
        ),
      )
      .orderBy(desc(approvalDelegations.id))
      .limit(ApprovalDelegationsService.LISTED);
    return { items: await this.views(rows) };
  }

  private invalid(
    path: string,
    key: string,
    args: Record<string, unknown> = {},
  ) {
    const message = this.engine.text(key, args);
    return new BadRequestException({
      code: 'validation_failed',
      message,
      errors: [{ path, message }],
    });
  }

  @Transactional()
  async create(user: UserPrincipal, dto: CreateDelegationDto, ip?: string) {
    const days = await this.settings.get(APPROVAL_MAX_DELEGATION_DAYS);
    if (
      new Date(dto.endsAt).getTime() - new Date(dto.startsAt).getTime() >
      days * 86_400_000
    ) {
      throw this.invalid('endsAt', 'delegationTooLong', { days });
    }
    if (dto.toUserId === user.id) {
      throw this.invalid('toUserId', 'delegateToSelf');
    }
    const [delegate] = await this.db
      .select({ id: users.id })
      .from(users)
      // A member of this tenant: users are global.
      .where(
        and(
          eq(users.id, dto.toUserId),
          eq(users.active, true),
          activeMember(users.id),
        ),
      );
    if (!delegate) throw this.invalid('toUserId', 'unknownUser');
    const [created] = await this.db
      .insert(approvalDelegations)
      .values({
        fromUserId: user.id,
        toUserId: dto.toUserId,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        subject: dto.subject ?? null,
      })
      .returning();
    await this.audit.record(user, {
      action: 'approvalDelegation.created',
      targetType: 'ApprovalDelegation',
      targetId: created!.id,
      details: {
        toUserId: dto.toUserId,
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
        subject: dto.subject ?? null,
      },
      ip,
    });
    return (await this.views([created!]))[0]!;
  }

  /** Ends one of the caller's own delegations (given, not received). */
  @Transactional()
  async remove(user: UserPrincipal, id: string, ip?: string) {
    const [removed] = await this.db
      .delete(approvalDelegations)
      .where(
        and(
          eq(approvalDelegations.id, id),
          eq(approvalDelegations.fromUserId, user.id),
        ),
      )
      .returning();
    if (!removed) throw new NotFoundException();
    await this.audit.record(user, {
      action: 'approvalDelegation.removed',
      targetType: 'ApprovalDelegation',
      targetId: id,
      details: { toUserId: removed.toUserId },
      ip,
    });
  }

  private async views(rows: ApprovalDelegationRow[]) {
    const ids = [
      ...new Set(rows.flatMap((row) => [row.fromUserId, row.toUserId])),
    ];
    const names = new Map(
      ids.length
        ? (
            await this.db
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, ids))
          ).map((row) => [row.id, row.name])
        : [],
    );
    const now = Date.now();
    return rows.map((row) => ({
      id: row.id,
      fromUserId: row.fromUserId,
      fromName: names.get(row.fromUserId) ?? '',
      toUserId: row.toUserId,
      toName: names.get(row.toUserId) ?? '',
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      subject: row.subject,
      active: row.startsAt.getTime() <= now && row.endsAt.getTime() > now,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}
