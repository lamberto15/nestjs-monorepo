import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, count, eq, inArray, type SQL } from 'drizzle-orm';
import { scimPatch } from 'scim-patch';
import { z } from 'zod';
import type {
  Database,
  DatabaseTransactions,
} from '../../../core/database/database.js';
import { databaseErrorKind } from '../../../core/database/database-errors.js';
import { httpConfig } from '../../../core/http/http.config.js';
import { AccessService } from '../../access/access.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { users } from '../../auth/auth.tables.js';
import type { ClientPrincipal } from '../../auth/principal.js';
import {
  currentMembership,
  openMembership,
} from '../../organization/memberships.js';
import {
  organizationalUnitClosure,
  organizationalUnitMemberships,
  organizationalUnits,
} from '../../organization/organization.tables.js';
import { ScimUnits } from '../../organization/scim-units.js';
import { UnitTree } from '../../organization/tree.js';
import { scimGroups } from '../sso.tables.js';
import { SCIM_SCHEMA, ScimException } from './scim-error.filter.js';
import { scimFilter, scimPage } from './scim-filter.js';
import {
  patchError,
  patchOperations,
  ScimUsersService,
} from './scim-users.service.js';

/** A SCIM Group as an IdP writes it (RFC 7643 §4.2): its name, and members by user id. */
export const scimGroupSchema = z.looseObject({
  schemas: z.array(z.string()).optional(),
  displayName: z.string().trim().min(1).max(200),
  externalId: z.string().max(512).nullish(),
  members: z
    .array(z.looseObject({ value: z.string().max(100) }))
    .max(10_000)
    .nullish(),
});
export type ScimGroupInput = z.infer<typeof scimGroupSchema>;

/**
 * SCIM 2.0 Groups as the tenant's organizational units (README.md, "SCIM"): a group the IdP creates is a top-level unit of type
 * `team`, its members the unit's current members. Only the units the SCIM
 * client created (a `scim_groups` row) are its, and only users it
 * provisioned can be their members: an IdP never reaches the units and
 * members administrators manage. A unit grants what roles with unit
 * conditions say, so the abilities are dropped on every change, as the
 * access API's are. A member removed has their membership ended (kept).
 *
 * The unit rows are written here, in SCIM's transaction, with the
 * organization module's tables and its UnitTree: OrganizationService's
 * writes take a user and their authority over the unit, which the IdP's
 * client has not. Administrators can't change these units
 * (`unit_managed_by_scim`, README.md "Integration").
 */
@Injectable()
@ScimUnits()
export class ScimGroupsService implements ScimUnits {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly scimUsers: ScimUsersService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    @Inject(httpConfig.KEY)
    private readonly http: ConfigType<typeof httpConfig>,
  ) {}

  private readonly tree = new UnitTree();

  /** Those of these units the tenant's IdP manages (its groups): organization refuses an administrator's change of them. */
  async managedUnitIds(unitIds: readonly string[]) {
    const rows = await this.db
      .select({ id: scimGroups.unitId })
      .from(scimGroups)
      .where(inArray(scimGroups.unitId, [...unitIds]));
    return new Set(rows.map((row) => row.id));
  }

  async list(query: {
    filter?: string;
    startIndex?: number;
    count?: number;
    excludedAttributes?: string;
  }) {
    const where = scimFilter(query.filter, {
      id: { column: scimGroups.unitId, uuid: true },
      displayName: { column: organizationalUnits.name, caseInsensitive: true },
      externalId: { column: scimGroups.externalId },
    });
    const page = scimPage(query.startIndex, query.count);
    const withMembers = !/(^|,)\s*members\s*(,|$)/i.test(
      query.excludedAttributes ?? '',
    );
    const [rows, [counted]] = await Promise.all([
      page.limit
        ? this.select(where)
            .orderBy(asc(scimGroups.createdAt), asc(scimGroups.unitId))
            .limit(page.limit)
            .offset(page.offset)
        : Promise.resolve([]),
      this.db
        .select({ total: count() })
        .from(scimGroups)
        .innerJoin(
          organizationalUnits,
          eq(organizationalUnits.id, scimGroups.unitId),
        )
        .where(where),
    ]);
    const members = withMembers
      ? await this.membersOf(rows.map((row) => row.unitId))
      : undefined;
    return {
      schemas: [SCIM_SCHEMA.list],
      totalResults: counted?.total ?? 0,
      startIndex: page.startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((row) =>
        this.resource(row, members?.get(row.unitId)),
      ),
    };
  }

  async get(id: string) {
    const row = await this.find(id);
    const members = await this.membersOf([id]);
    return this.resource(row, members.get(id) ?? []);
  }

  async create(actor: ClientPrincipal, input: ScimGroupInput, ip?: string) {
    const unitId = await this.unique(() =>
      this.txHost.withTransaction(async () => {
        if (input.externalId) {
          await this.assertExternalIdFree(input.externalId);
        }
        // A top-level team of its own.
        const [unit] = await this.db
          .insert(organizationalUnits)
          .values({ type: 'team', name: input.displayName, parentId: null })
          .returning();
        await this.tree.add(this.db, unit!.id, null);
        await this.db.insert(scimGroups).values({
          unitId: unit!.id,
          externalId: input.externalId ?? null,
        });
        const members = await this.setMembers(unit!.id, memberIds(input));
        await this.audit.record(actor, {
          action: 'scim.group-created',
          targetType: 'organizationalUnit',
          targetId: unit!.id,
          details: {
            name: unit!.name,
            externalId: input.externalId ?? null,
            members,
          },
          ip,
        });
        return unit!.id;
      }),
    );
    this.access.invalidate();
    return this.get(unitId);
  }

  /** PUT: its name, externalId and members are what the IdP sent. */
  replace(
    actor: ClientPrincipal,
    id: string,
    input: ScimGroupInput,
    ip?: string,
  ) {
    return this.write(actor, id, () => Promise.resolve(input), ip);
  }

  /**
   * Writes the representation `next` makes, under the group's lock: a
   * PATCH reads the members it applies to only once it holds it, so two at
   * once (an IdP pushes each change on its own) never write back each
   * other's stale member list.
   */
  private async write(
    actor: ClientPrincipal,
    id: string,
    next: () => Promise<ScimGroupInput>,
    ip?: string,
  ) {
    await this.unique(() =>
      this.txHost.withTransaction(async () => {
        await this.lock(id);
        const input = await next();
        const before = await this.find(id);
        if (input.externalId && input.externalId !== before.externalId) {
          await this.assertExternalIdFree(input.externalId);
        }
        await this.db
          .update(organizationalUnits)
          .set({ name: input.displayName })
          .where(eq(organizationalUnits.id, id));
        await this.db
          .update(scimGroups)
          .set({ externalId: input.externalId ?? null, updatedAt: new Date() })
          .where(eq(scimGroups.unitId, id));
        const members = await this.setMembers(id, memberIds(input));
        await this.audit.record(actor, {
          action: 'scim.group-updated',
          targetType: 'organizationalUnit',
          targetId: id,
          details: {
            ...(before.name !== input.displayName && {
              name: { from: before.name, to: input.displayName },
            }),
            members,
          },
          ip,
        });
      }),
    );
    this.access.invalidate();
    return this.get(id);
  }

  /** PATCH: scim-patch applies the operations (members added or removed by filter) to the group as answered. */
  async patch(actor: ClientPrincipal, id: string, body: unknown, ip?: string) {
    const operations = patchOperations(body);
    return this.write(actor, id, () => this.patched(id, operations), ip);
  }

  /** The group as it is now (read under write()'s lock), with `operations` applied. */
  private async patched(
    id: string,
    operations: ReturnType<typeof patchOperations>,
  ): Promise<ScimGroupInput> {
    const current = await this.get(id);
    let patched: unknown;
    try {
      patched = scimPatch(
        current as unknown as Parameters<typeof scimPatch>[0],
        operations,
        { mutateDocument: false, treatMissingAsAdd: true },
      );
    } catch (error) {
      throw patchError(error);
    }
    const parsed = scimGroupSchema.safeParse(patched);
    if (!parsed.success) {
      throw new ScimException(
        400,
        `The patched group is invalid: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        'invalidValue',
      );
    }
    return parsed.data;
  }

  /** DELETE: the unit goes, with its memberships (not the members). */
  async remove(actor: ClientPrincipal, id: string, ip?: string) {
    await this.txHost.withTransaction(async () => {
      await this.lock(id);
      const before = await this.find(id);
      const [under] = await this.db
        .select({ children: count() })
        .from(organizationalUnits)
        .where(eq(organizationalUnits.parentId, id));
      if (under!.children > 0) {
        // An administrator put units under it: theirs to move first.
        throw new ScimException(
          409,
          'Units were put under this group: an administrator moves them first.',
        );
      }
      await this.db.delete(scimGroups).where(eq(scimGroups.unitId, id));
      // Its memberships (not the members) and its own paths go with it.
      await this.db
        .delete(organizationalUnitMemberships)
        .where(eq(organizationalUnitMemberships.unitId, id));
      await this.db
        .delete(organizationalUnitClosure)
        .where(eq(organizationalUnitClosure.descendantId, id));
      await this.db
        .delete(organizationalUnits)
        .where(eq(organizationalUnits.id, id))
        .catch((error: unknown) => {
          // Records or saved views of the unit: no cascade.
          throw databaseErrorKind(error) === 'foreign_key_violation'
            ? new ScimException(
                409,
                'Records or saved views belong to this group: an administrator moves them first.',
              )
            : error;
        });
      await this.audit.record(actor, {
        action: 'scim.group-deleted',
        targetType: 'organizationalUnit',
        targetId: id,
        details: { name: before.name, externalId: before.externalId },
        ip,
      });
    });
    this.access.invalidate();
  }

  /**
   * The unit's current members become `ids`: only users the SCIM client
   * provisioned (any other id is a 400, never a member of the tenant
   * added through a group). Returns what changed, for the audit entry.
   */
  private async setMembers(unitId: string, ids: string[]) {
    const wanted = [...new Set(ids)];
    const valid = wanted.filter((id) => z.uuid().safeParse(id).success);
    const provisioned = await this.scimUsers.provisioned(valid);
    if (provisioned.length !== wanted.length) {
      throw new ScimException(
        400,
        'A member isn’t a user provisioned over SCIM.',
        'invalidValue',
      );
    }
    const now = new Date();
    const open = await this.db
      .select({
        id: organizationalUnitMemberships.id,
        userId: organizationalUnitMemberships.userId,
      })
      .from(organizationalUnitMemberships)
      .where(
        and(
          eq(organizationalUnitMemberships.unitId, unitId),
          openMembership(now),
        ),
      );
    const removed = open.filter((row) => !wanted.includes(row.userId));
    const added = wanted.filter(
      (userId) => !open.some((row) => row.userId === userId),
    );
    if (removed.length) {
      // Ended, kept as history.
      await this.db
        .update(organizationalUnitMemberships)
        .set({ validTo: now })
        .where(
          inArray(
            organizationalUnitMemberships.id,
            removed.map((row) => row.id),
          ),
        );
    }
    if (added.length) {
      await this.db
        .insert(organizationalUnitMemberships)
        .values(added.map((userId) => ({ unitId, userId, validFrom: now })));
    }
    return { added, removed: removed.map((row) => row.userId) };
  }

  private async membersOf(unitIds: string[]) {
    const byUnit = new Map<string, { value: string; display: string }[]>();
    if (!unitIds.length) {
      return byUnit;
    }
    const member = organizationalUnitMemberships;
    const rows = await this.db
      .select({
        unitId: member.unitId,
        userId: member.userId,
        email: users.email,
      })
      .from(member)
      .innerJoin(users, eq(users.id, member.userId))
      .where(and(inArray(member.unitId, unitIds), currentMembership()))
      .orderBy(asc(users.email));
    for (const row of rows) {
      const list = byUnit.get(row.unitId) ?? [];
      list.push({ value: row.userId, display: row.email });
      byUnit.set(row.unitId, list);
    }
    return byUnit;
  }

  private async assertExternalIdFree(externalId: string) {
    const [taken] = await this.db
      .select({ unitId: scimGroups.unitId })
      .from(scimGroups)
      .where(eq(scimGroups.externalId, externalId));
    if (taken) {
      throw new ScimException(
        409,
        'Another group has this externalId.',
        'uniqueness',
      );
    }
  }

  private async unique<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (databaseErrorKind(error) === 'unique_violation') {
        throw new ScimException(
          409,
          constraintOf(error) === 'organizational_units_sibling_name_idx'
            ? 'A top-level unit already has this displayName (any case).'
            : 'Another group has this externalId.',
          'uniqueness',
        );
      }
      throw error;
    }
  }

  private select(where?: SQL) {
    return this.db
      .select({
        unitId: scimGroups.unitId,
        externalId: scimGroups.externalId,
        name: organizationalUnits.name,
        createdAt: scimGroups.createdAt,
        updatedAt: scimGroups.updatedAt,
      })
      .from(scimGroups)
      .innerJoin(
        organizationalUnits,
        eq(organizationalUnits.id, scimGroups.unitId),
      )
      .where(where);
  }

  /** The group's row locked until the transaction ends: its writes one at a time. */
  private async lock(id: string) {
    if (!z.uuid().safeParse(id).success) return;
    await this.db
      .select({ unitId: scimGroups.unitId })
      .from(scimGroups)
      .where(eq(scimGroups.unitId, id))
      .for('update');
  }

  private async find(id: string) {
    if (!z.uuid().safeParse(id).success) {
      throw new ScimException(404, `Group ${id} not found.`);
    }
    const [row] = await this.select(eq(scimGroups.unitId, id));
    if (!row) {
      throw new ScimException(404, `Group ${id} not found.`);
    }
    return row;
  }

  private resource(
    row: {
      unitId: string;
      externalId: string | null;
      name: string;
      createdAt: Date;
      updatedAt: Date;
    },
    members?: { value: string; display: string }[],
  ) {
    const base = this.http.appUrl;
    return {
      schemas: [SCIM_SCHEMA.group],
      id: row.unitId,
      ...(row.externalId !== null && { externalId: row.externalId }),
      displayName: row.name,
      ...(members && {
        members: members.map((member) => ({
          ...member,
          $ref: `${base}/v1/scim/Users/${member.value}`,
        })),
      }),
      meta: {
        resourceType: 'Group',
        created: row.createdAt.toISOString(),
        lastModified: row.updatedAt.toISOString(),
        location: `${base}/v1/scim/Groups/${row.unitId}`,
      },
    };
  }
}

const memberIds = (input: ScimGroupInput) =>
  (input.members ?? []).map((member) => member.value);

/** The constraint a PostgreSQL error names (on the error, or the `cause` Drizzle wraps it in). */
const constraintOf = (error: unknown): string | undefined =>
  (error as { constraint?: string })?.constraint ??
  (error as { cause?: { constraint?: string } })?.cause?.constraint;
