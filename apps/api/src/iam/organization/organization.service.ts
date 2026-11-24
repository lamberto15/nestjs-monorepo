import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { t } from '@nestjs/i18n';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessService } from '../access/access.service.js';
import { MembersService } from '../access/members.service.js';
import { RolesService } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import { discoverOne } from '../auth/discover.js';
import type { SystemPrincipal, UserPrincipal } from '../auth/principal.js';
import type { UnitsOfOptions } from './memberships.js';
import { OrganizationRepository } from './organization.repository.js';
import type { UnitRole, UnitType } from './organization.tables.js';
import { ScimUnits } from './scim-units.js';
import { TreeCycleError } from './tree.js';
import { OrganizationUnitDirectory } from './unit-directory.provider.js';

/** The 409 of a name a sibling already has (any case). */
const nameTaken = (name: string) =>
  new ConflictException({
    code: 'unit_name_taken',
    message: `A unit beside it is already named "${name}" (names are unique among siblings, ignoring case).`,
  });

const notEmpty = () =>
  new ConflictException({
    code: 'unit_not_empty',
    message:
      'Move or delete the units under it, end its memberships, and move what refers to it (records, saved views) first.',
  });

/** The 409 of a unit the tenant's IdP manages over SCIM: it changes there. */
const managedByScim = () =>
  new ConflictException({
    code: 'unit_managed_by_scim',
    message: t('organization.managedByScim'),
  });

const rethrowNameTaken = (name: string) => (error: unknown) => {
  throw databaseErrorKind(error) === 'unique_violation'
    ? nameTaken(name)
    : error;
};

/** What a preview throws to roll its transaction back, carrying its result. */
class PreviewRollback<T> extends Error {
  constructor(readonly result: T) {
    super('preview');
  }
}

/** The users an access-impact preview compares at most (`truncated` past them). */
export const IMPACT_USERS_LIMIT = 500;

export interface UnitChanges {
  type?: UnitType;
  name?: string;
  parentId?: string | null;
}

export interface Impact {
  changes: {
    userId: string;
    name: string;
    email: string;
    andBelow: { gains: string[]; loses: string[] };
    ledAndBelow: { gains: string[]; loses: string[] };
  }[];
  truncated: boolean;
}

/**
 * The tenant's organizational units, in one tree kept by a closure table:
 * create, rename, retype, move (a whole subtree at once), delete an empty
 * unit, and the memberships of users in them, dated (`validFrom`,
 * `validTo`): ending one keeps it as history. Placing someone takes
 * authority over them (RolesService) and over the unit. Every change is
 * audited, and drops the cached abilities everywhere (the unit conditions
 * read them).
 */
@Injectable()
export class OrganizationService implements OnModuleInit {
  private scim?: ScimUnits;

  constructor(
    private readonly repository: OrganizationRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly roles: RolesService,
    private readonly members: MembersService,
    private readonly directory: OrganizationUnitDirectory,
    private readonly discovery: DiscoveryService,
  ) {}

  onModuleInit() {
    this.scim = discoverOne<ScimUnits>(
      this.discovery,
      ScimUnits,
      'SCIM units source (@ScimUnits())',
    );
  }

  /** Every unit, with its parent, depth, current members and whether SCIM manages it, top-level first. */
  async list() {
    const now = new Date();
    const [rows, depths, counts] = await Promise.all([
      this.repository.units(),
      this.repository.ancestorCounts(),
      this.repository.memberCounts(now),
    ]);
    const scim = await this.scimManaged(rows.map((unit) => unit.id));
    return rows
      .map((unit) => ({
        ...unit,
        // A unit is its own ancestor: the count of its ancestors, minus one.
        depth: (depths.find((row) => row.id === unit.id)?.depth ?? 1) - 1,
        members: counts.find((row) => row.id === unit.id)?.members ?? 0,
        managedByScim: scim.has(unit.id),
      }))
      .sort((a, b) => a.depth - b.depth);
  }

  /** `actor`: an administrator, or a system job (a demo seed). */
  async create(
    actor: UserPrincipal | SystemPrincipal,
    input: { type: UnitType; name: string; parentId?: string | null },
    ip?: string,
  ) {
    const unit = await this.txHost.withTransaction(async () => {
      if (input.parentId) await this.find(input.parentId);
      const row = await this.repository
        .insert({
          type: input.type,
          name: input.name,
          parentId: input.parentId ?? null,
        })
        .catch(rethrowNameTaken(input.name));
      await this.repository.addToTree(row.id, row.parentId);
      await this.audit.record(actor, {
        action: 'organizationalUnit.created',
        targetType: 'organizationalUnit',
        targetId: row.id,
        details: { type: row.type, name: row.name, parentId: row.parentId },
        ip,
      });
      return row;
    });
    this.access.invalidate(this.tenancy.tenantId());
    return unit;
  }

  /** Renames or retypes a unit, or moves it (with everything under it) under another parent. */
  async update(
    actor: UserPrincipal,
    id: string,
    changes: UnitChanges,
    ip?: string,
  ) {
    const unit = await this.txHost.withTransaction(async () => {
      const before = await this.find(id);
      await this.assertNotScimManaged(id);
      const moved =
        changes.parentId !== undefined && changes.parentId !== before.parentId;
      if (moved) {
        if (changes.parentId) await this.find(changes.parentId);
        try {
          await this.repository.moveInTree(id, changes.parentId ?? null);
        } catch (error) {
          if (error instanceof TreeCycleError) {
            throw new ConflictException(
              'A unit can’t move under itself or a unit below it.',
            );
          }
          throw error;
        }
      }
      const row = await this.repository
        .update(id, {
          ...(changes.type !== undefined && { type: changes.type }),
          ...(changes.name !== undefined && { name: changes.name }),
          ...(changes.parentId !== undefined && { parentId: changes.parentId }),
        })
        .catch(rethrowNameTaken(changes.name ?? before.name));
      await this.audit.record(actor, {
        action: 'organizationalUnit.updated',
        targetType: 'organizationalUnit',
        targetId: id,
        details: {
          ...(changes.type !== undefined && {
            type: { from: before.type, to: changes.type },
          }),
          ...(changes.name !== undefined && {
            name: { from: before.name, to: changes.name },
          }),
          ...(moved && {
            parentId: { from: before.parentId, to: changes.parentId },
          }),
        },
        ip,
      });
      return row;
    });
    this.access.invalidate(this.tenancy.tenantId());
    return unit;
  }

  /**
   * What a change of the unit would change, without making it: the change
   * runs (its checks, its 404s and 409s) in a transaction rolled back. Only
   * the members of the units above it, before and after, can gain or lose
   * reach below (a move takes the units under it along), and the members
   * of it and the units under it reach above (`inMyUnitsAndAbove`).
   */
  previewUpdate(actor: UserPrincipal, id: string, changes: UnitChanges) {
    return this.impactOf(
      () =>
        this.repository.affectedByUnitChange(
          id,
          changes.parentId !== undefined,
          changes.parentId,
          IMPACT_USERS_LIMIT + 1,
        ),
      () => this.update(actor, id, changes),
    );
  }

  /**
   * Deletes an empty unit: none under it, no current or future membership,
   * nothing referring to it. No cascade: a 409 `unit_not_empty`
   * otherwise. Its ended memberships go with it.
   */
  async remove(actor: UserPrincipal, id: string, ip?: string) {
    await this.txHost.withTransaction(async () => {
      const unit = await this.find(id);
      await this.assertNotScimManaged(id);
      // One after the other: a transaction is one connection.
      const children = await this.repository.countChildren(id);
      const open = await this.repository.countOpenMemberships(id);
      if (children > 0 || open > 0) throw notEmpty();
      // Ended memberships and the unit's own paths go with it; what other
      // modules' tables refer to it is theirs to know: their keys restrict.
      await this.repository.deleteMembershipsAndPaths(id);
      await this.repository.delete(id).catch((error: unknown) => {
        throw databaseErrorKind(error) === 'foreign_key_violation'
          ? notEmpty()
          : error;
      });
      await this.audit.record(actor, {
        action: 'organizationalUnit.deleted',
        targetType: 'organizationalUnit',
        targetId: id,
        details: { type: unit.type, name: unit.name },
        ip,
      });
    });
    this.access.invalidate(this.tenancy.tenantId());
  }

  /**
   * The units a user is a current member of (`role`: only those they hold
   * that role in), and with `below` every unit under them.
   */
  async unitsOf(userId: string, options: UnitsOfOptions = {}) {
    return this.repository.unitIdsOf(userId, options);
  }

  /** A unit of the tenant, or a 404. */
  get(id: string) {
    return this.find(id);
  }

  /**
   * The units above these, level by level: `[0]` is the units themselves,
   * `[1]` their parents, and so on up to the highest ancestor.
   */
  async ancestry(unitIds: readonly string[]): Promise<string[][]> {
    if (!unitIds.length) return [];
    const rows = await this.repository.ancestorsOf([...unitIds]);
    const levels: string[][] = [];
    for (const { id, depth } of rows) (levels[depth] ??= []).push(id);
    return levels;
  }

  /** The accounts that are current members of any of these units. */
  async currentMembers(unitIds: readonly string[]): Promise<string[]> {
    if (!unitIds.length) return [];
    return this.repository.currentMemberIds([...unitIds]);
  }

  /** A unit's memberships, current and past, latest first, with each member's name and email. */
  async membersOf(unitId: string) {
    await this.find(unitId);
    return this.repository.membershipsOf(unitId);
  }

  /**
   * Opens a membership of `userId` in the unit, as a member or its lead,
   * from `validFrom` (default now) until `validTo` (default open). One
   * open membership per unit and user: a second is a 409. By someone with
   * authority over the user and the unit.
   */
  async addMember(
    actor: UserPrincipal,
    unitId: string,
    input: {
      userId: string;
      role?: UnitRole;
      validFrom?: string;
      validTo?: string | null;
    },
    ip?: string,
  ) {
    await this.assertAuthorityOverMember(actor, input.userId);
    await this.assertAuthorityOverUnit(actor, unitId, input.role);
    const row = await this.txHost.withTransaction(async () => {
      await this.find(unitId);
      await this.assertNotScimManaged(unitId);
      if (!(await this.repository.isTenantMember(input.userId)))
        throw new BadRequestException('Unknown user.');
      if (await this.repository.openMembershipOf(unitId, input.userId)) {
        throw new ConflictException(
          'The user is already a member of this unit: change their role or end it first.',
        );
      }
      const validFrom = input.validFrom
        ? new Date(input.validFrom)
        : new Date();
      const validTo = input.validTo ? new Date(input.validTo) : null;
      if (validTo && validTo <= validFrom) {
        throw new BadRequestException('validTo must be after validFrom.');
      }
      const created = await this.repository.insertMembership({
        unitId,
        userId: input.userId,
        role: input.role ?? 'member',
        validFrom,
        validTo,
      });
      await this.audit.record(actor, {
        action: 'organizationalUnit.member-added',
        targetType: 'organizationalUnit',
        targetId: unitId,
        details: {
          userId: created.userId,
          role: created.role,
          validFrom: created.validFrom,
          validTo: created.validTo,
        },
        ip,
      });
      return created;
    });
    this.access.invalidate(this.tenancy.tenantId());
    return row;
  }

  /** Changes a member's role: the open membership ends now and a new one opens (history kept). */
  async changeMemberRole(
    actor: UserPrincipal,
    unitId: string,
    userId: string,
    role: UnitRole,
    ip?: string,
  ) {
    await this.assertAuthorityOverMember(actor, userId);
    // Either way, a lead is made or unmade: a lead's authority.
    await this.assertAuthorityOverUnit(actor, unitId, 'lead');
    const row = await this.txHost.withTransaction(async () => {
      await this.find(unitId);
      await this.assertNotScimManaged(unitId);
      const open = await this.repository.openMembershipOf(unitId, userId);
      if (!open)
        throw new NotFoundException('The user is not a member of this unit.');
      if (open.role === role) return open;
      const now = new Date();
      let changed: typeof open | undefined;
      if (open.validFrom >= now) {
        // Not started yet: nothing to keep as history.
        changed = await this.repository.setMembershipRole(open.id, role);
      } else {
        await this.end(open.id, now);
        changed = await this.repository.insertMembership({
          unitId,
          userId,
          role,
          validFrom: now,
          validTo: open.validTo,
        });
      }
      await this.audit.record(actor, {
        action: 'organizationalUnit.member-role-changed',
        targetType: 'organizationalUnit',
        targetId: unitId,
        details: { userId, role: { from: open.role, to: role } },
        ip,
      });
      return changed!;
    });
    this.access.invalidate(this.tenancy.tenantId());
    return row;
  }

  /** What `changeMemberRole()` would change of the user's reach, without making it. */
  previewMemberRole(
    actor: UserPrincipal,
    unitId: string,
    userId: string,
    role: UnitRole,
  ) {
    return this.impactOf(
      async () => [userId],
      () => this.changeMemberRole(actor, unitId, userId, role),
    );
  }

  /** Ends a user's open membership of the unit now (kept as history; one not started yet is dropped). */
  async removeMember(
    actor: UserPrincipal,
    unitId: string,
    userId: string,
    ip?: string,
  ) {
    await this.assertAuthorityOverMember(actor, userId);
    await this.assertAuthorityOverUnit(actor, unitId);
    await this.txHost.withTransaction(async () => {
      await this.find(unitId);
      await this.assertNotScimManaged(unitId);
      const open = await this.repository.openMembershipOf(unitId, userId);
      if (!open)
        throw new NotFoundException('The user is not a member of this unit.');
      await this.end(open.id, new Date());
      await this.audit.record(actor, {
        action: 'organizationalUnit.member-removed',
        targetType: 'organizationalUnit',
        targetId: unitId,
        details: { userId, role: open.role },
        ip,
      });
    });
    this.access.invalidate(this.tenancy.tenantId());
  }

  /**
   * Who gains or loses reach under `inMyUnitsAndBelow`,
   * `inMyUnitsAndAbove` and `inUnitsILeadAndBelow` if `apply` ran: each user's units are read as
   * the unit conditions read them, before and after `apply`, in one
   * transaction that is then rolled back, so nothing changes and nothing
   * is audited. The first IMPACT_USERS_LIMIT users only (`truncated`).
   */
  private async impactOf(
    userIds: () => Promise<string[]>,
    apply: () => Promise<unknown>,
  ): Promise<Impact> {
    try {
      await this.txHost.withTransaction(async () => {
        const candidates = await userIds();
        const ids = candidates.slice(0, IMPACT_USERS_LIMIT);
        // One after the other: a transaction is one connection.
        const reach = async () => {
          const contexts = [];
          for (const id of ids)
            contexts.push(await this.directory.unitContext(id));
          return contexts;
        };
        const before = await reach();
        await apply();
        const after = await reach();
        const people = ids.length ? await this.repository.people(ids) : [];
        const diff = (from: readonly string[], to: readonly string[]) => ({
          gains: to.filter((unit) => !from.includes(unit)),
          loses: from.filter((unit) => !to.includes(unit)),
        });
        const changes = ids.flatMap((id, i) => {
          const andBelow = diff(
            before[i]!.unitIdsAndBelow,
            after[i]!.unitIdsAndBelow,
          );
          const andAbove = diff(
            before[i]!.unitIdsAndAbove,
            after[i]!.unitIdsAndAbove,
          );
          const ledAndBelow = diff(
            before[i]!.ledUnitIdsAndBelow,
            after[i]!.ledUnitIdsAndBelow,
          );
          const person = people.find((row) => row.id === id);
          return [andBelow, andAbove, ledAndBelow].some(
            (change) => change.gains.length || change.loses.length,
          )
            ? [
                {
                  userId: id,
                  name: person?.name ?? '',
                  email: person?.email ?? '',
                  andBelow,
                  andAbove,
                  ledAndBelow,
                },
              ]
            : [];
        });
        throw new PreviewRollback<Impact>({
          changes,
          truncated: candidates.length > IMPACT_USERS_LIMIT,
        });
      });
    } catch (error) {
      if (error instanceof PreviewRollback) return error.result as Impact;
      throw error;
    } finally {
      // The change ran (and was rolled back): its invalidation must not
      // leave abilities built inside the rolled-back transaction.
      this.access.invalidate(this.tenancy.tenantId());
    }
    throw new Error('A preview always rolls back.');
  }

  /** A member of the tenant (anyone else: 404) the actor has authority over; never oneself. */
  private async assertAuthorityOverMember(
    actor: UserPrincipal,
    userId: string,
  ) {
    // What an administrator sees would follow their own units.
    if (actor.id === userId) {
      throw new ForbiddenException('You can’t change your own units.');
    }
    const member = await this.members.find(userId);
    await this.roles.assertAuthorityOver(actor, userId, member.email);
  }

  /**
   * Who places someone in a unit (or takes them out) needs authority over
   * the unit too: `manageOrganizationalUnits`, or a current membership of
   * it or of a unit above it. Otherwise an account given at most your
   * roles could be put in any unit and read, under "my units and below",
   * what you can't. `lead`: making or unmaking a lead takes leading it
   * (or a unit above it).
   */
  private async assertAuthorityOverUnit(
    actor: UserPrincipal,
    unitId: string,
    role: UnitRole = 'member',
  ) {
    if (await this.access.can(actor, 'manageOrganizationalUnits', 'Access'))
      return;
    const mine = await this.unitsOf(actor.id, {
      below: true,
      ...(role === 'lead' && { role: 'lead' as const }),
    });
    if (!mine.includes(unitId)) {
      throw new ForbiddenException({
        code: 'unit_authority_required',
        message:
          role === 'lead'
            ? 'You can’t make or unmake a lead of a unit you neither manage nor lead (or one above it).'
            : 'You can’t place people in a unit you neither manage nor belong to (or one above it).',
      });
    }
  }

  /** Ends a membership at `at`; one that hadn't started by then never counted, and goes. */
  private async end(id: string, at: Date) {
    if (!(await this.repository.endMembership(id, at))) {
      await this.repository.deleteMembership(id);
    }
  }

  /** Those of these units the tenant's IdP manages over SCIM (`@ScimUnits()`); none without it. */
  private async scimManaged(ids: string[]) {
    return ids.length && this.scim
      ? this.scim.managedUnitIds(ids)
      : new Set<string>();
  }

  /** 409 `unit_managed_by_scim`: the IdP's unit changes there, never here. */
  private async assertNotScimManaged(id: string) {
    if ((await this.scimManaged([id])).has(id)) throw managedByScim();
  }

  private async find(id: string) {
    const unit = await this.repository.findById(id);
    if (!unit)
      throw new NotFoundException(`Organizational unit ${id} not found.`);
    return unit;
  }
}
