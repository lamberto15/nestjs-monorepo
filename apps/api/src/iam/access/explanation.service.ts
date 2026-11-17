import { InjectTransaction } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { UserPrincipal } from '../auth/principal.js';
import {
  AccessRecordFinder,
  type RecordFinder,
} from './access-record-finder.js';
import { AccessService } from './access.service.js';
import { roles, userRoles } from './access.tables.js';
import { MembersService } from './members.service.js';
import { PermissionCatalog } from './permission-catalog.js';
import { isAll } from './permissions.js';

/**
 * Why a member may or may not act on a subject or one of its records
 * (README.md, "Explaining access"): AccessService.explain() does the
 * checking with the engine's own code; this adds who, which roles, and
 * keeps it to what the asker may see. The record is looked up as the
 * asker (one they may not read is a 404, as on its own routes), and an
 * answer that a field hidden from them decides is withheld.
 */
@Injectable()
export class ExplanationService implements OnModuleInit {
  private readonly finders = new Map<string, RecordFinder>();

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly access: AccessService,
    private readonly catalog: PermissionCatalog,
    private readonly members: MembersService,
    private readonly discovery: DiscoveryService,
  ) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders({
      metadataKey: AccessRecordFinder.KEY,
    })) {
      const subject = this.discovery.getMetadataByDecorator(
        AccessRecordFinder,
        wrapper,
      );
      if (!subject || !wrapper.instance) continue;
      if (this.finders.has(subject)) {
        throw new Error(
          `Two record finders for "${subject}" (@AccessRecordFinder()).`,
        );
      }
      this.finders.set(subject, wrapper.instance as RecordFinder);
    }
  }

  async explain(
    asker: UserPrincipal,
    userId: string,
    subject: string,
    recordId?: string,
  ) {
    const declared = Object.hasOwn(this.catalog.subjects, subject)
      ? this.catalog.subjects[subject]
      : undefined;
    if (!declared) {
      throw new BadRequestException({
        code: 'unknown_subject',
        message: `No permission subject is named ${subject}.`,
      });
    }
    const member = await this.members.find(userId);
    let record: Record<string, unknown> | undefined;
    let hidden: string[] = [];
    if (recordId) {
      const finder = this.finders.get(subject);
      if (!finder) {
        throw new BadRequestException({
          code: 'subject_without_records',
          message: `${subject} has no records to explain: leave recordId out.`,
        });
      }
      const found = await finder.find(recordId, asker);
      if (!found) {
        throw new NotFoundException(`${subject} ${recordId} not found.`);
      }
      record = found;
      const shown = await this.access.redact(asker, 'read', subject, found);
      hidden = this.catalog
        .declaredFields(subject)
        .filter((field) => !(field in shown));
    }
    // The ability reads only the principal's kind and id (and the request's tenant).
    const principal = { kind: 'user', id: userId } as UserPrincipal;
    const [explanation, grants] = await Promise.all([
      this.access.explain(
        principal,
        subject,
        Object.keys(declared.actions),
        record,
        hidden,
      ),
      this.db
        .select({
          id: roles.id,
          name: roles.name,
          expiresAt: userRoles.expiresAt,
        })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(eq(userRoles.userId, userId))
        .orderBy(asc(roles.name)),
    ]);
    const now = Date.now();
    return {
      user: { id: member.id, name: member.name, email: member.email },
      subject,
      recordId: recordId ?? null,
      // Every grant, an ended one too: it counts for nothing (`expired`).
      roles: grants.map((grant) => ({
        id: grant.id,
        name: grant.name,
        expiresAt: grant.expiresAt?.toISOString() ?? null,
        expired: grant.expiresAt !== null && grant.expiresAt.getTime() <= now,
      })),
      units: {
        direct: explanation.context.directUnitIds,
        andBelow: explanation.context.unitIdsAndBelow,
        ledAndBelow: explanation.context.ledUnitIdsAndBelow,
      },
      actions: explanation.actions.map((action) => ({
        action: action.action,
        allowed: action.allowed,
        fields: action.fields,
        grants: action.grants.map((grant) => {
          const { permission, roleId, expiresAt } =
            explanation.held[grant.index]!;
          return {
            roleId,
            expiresAt: expiresAt?.toISOString() ?? null,
            all: isAll(permission),
            fields: permission.fields ?? null,
            matches: grant.matches,
            conditions: grant.conditions.map((condition, i) => ({
              key: condition.key,
              params: permission.conditions[i]?.params ?? null,
              matches: condition.matches,
            })),
          };
        }),
      })),
    };
  }
}
