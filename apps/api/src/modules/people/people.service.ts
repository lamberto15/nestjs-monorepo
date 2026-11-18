import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, max } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { escapeLike } from '../../core/http/list-query.js';
import { afterCursor, toPage } from '../../core/http/pagination.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { ActorNameSource } from '../../iam/audit/actor-names.js';
import { apiClients, memberships, users } from '../../iam/auth/auth.tables.js';
import type { Principal } from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import {
  organizationalUnitClosure,
  organizationalUnits,
  type UnitType,
} from '../../iam/organization/organization.tables.js';
import { AvatarsService } from '../attachments/avatars/avatars.service.js';
import type { UnitsQuery } from './people.schemas.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Who someone is, as any member of the tenant may see them: their key and name. */
export interface Person {
  /** `user:<id>`: what `@user:<id>` mentions, and what an author or owner column holds. */
  key: string;
  name: string;
  /** The picture's path (modules/attachments/avatars), null for none and for an API client. */
  avatarUrl: string | null;
}

/** A unit, as any member of the tenant may see it: its name and its place in the tree. */
export interface UnitRef {
  id: string;
  type: UnitType;
  name: string;
  parentId: string | null;
  /** 0 for a top-level unit. */
  depth: number;
}

/**
 * The people of the current tenant, as its members see each other: the
 * names behind the principal keys records store (`GET /v1/people?key=`), the
 * directory @mention autocomplete searches (`GET /v1/people`), and the
 * units' names and tree (`GET /v1/organizational-units`). Only a key and a
 * name, never an address or a role (a unit: its id, name and place, never
 * its members): the access API is where they are managed. Users are global:
 * every query is held to the tenant's memberships, so a key of someone
 * outside it has no name here. API clients and units are tenant rows behind
 * row-level security.
 */
@Injectable()
@ActorNameSource() // The audit log and the revisions name who acted through it.
export class PeopleService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly tenancy: Tenancy,
    private readonly users: UsersRepository,
    private readonly avatars: AvatarsService,
  ) {}

  /** `user:<id>` keys' pictures, a key with none (or a client) null. */
  private async withAvatars(
    people: { key: string; name: string }[],
  ): Promise<Person[]> {
    return Promise.all(
      people.map(async (person) => ({
        ...person,
        avatarUrl: person.key.startsWith('user:')
          ? await this.avatars.urlOf(person.key.slice('user:'.length))
          : null,
      })),
    );
  }

  /**
   * The `user:<id>` keys behind these addresses (lower-cased, as
   * `users.email` is), among `among` only: a mention is told by an address
   * only where it already resolved to one of the keys a comment holds, so
   * this never says whether an address belongs to anyone else.
   */
  async keysOfEmails(
    emails: Iterable<string>,
    among: Iterable<string>,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(among)]
      .filter((key) => key.startsWith('user:'))
      .map((key) => key.slice('user:'.length))
      .filter((id) => UUID.test(id));
    const addresses = [...new Set(emails)];
    if (!ids.length || !addresses.length) {
      return new Map();
    }
    const rows = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(inArray(users.id, ids), inArray(users.email, addresses)));
    return new Map(rows.map((row) => [row.email, `user:${row.id}`]));
  }

  /**
   * The names of these principal keys, in two queries whatever their number
   * (a page's authors): a user who is or was a member of the tenant (their
   * membership may be inactive since: the name stays on what they wrote), an
   * API client of the tenant. Anything else (a deleted account, another
   * tenant's user, a removed client) is null.
   */
  async names(keys: Iterable<string>): Promise<Map<string, string | null>> {
    const all = [...new Set(keys)];
    const ids = (kind: string) =>
      all
        .filter((key) => key.startsWith(`${kind}:`))
        .map((key) => key.slice(kind.length + 1))
        .filter((id) => UUID.test(id));
    const userIds = ids('user');
    const clientIds = ids('client');
    const tenantId = this.tenancy.tenantId();
    const [people, clients] = await Promise.all([
      userIds.length
        ? this.db
            .select({ id: users.id, name: users.name })
            .from(users)
            .innerJoin(
              memberships,
              and(
                eq(memberships.userId, users.id),
                eq(memberships.tenantId, tenantId),
              ),
            )
            .where(inArray(users.id, userIds))
        : [],
      clientIds.length
        ? this.db
            .select({ id: apiClients.id, name: apiClients.name })
            .from(apiClients)
            .where(inArray(apiClients.id, clientIds))
        : [],
    ]);
    const found = new Map<string, string>([
      ...people.map((row) => [`user:${row.id}`, row.name] as const),
      ...clients.map((row) => [`client:${row.id}`, row.name] as const),
    ]);
    return new Map(all.map((key) => [key, found.get(key) ?? null]));
  }

  /**
   * The people behind these keys (`user:<id>`, `client:<id>`), in the order
   * asked, each once. A key with no name here (another tenant's user, a
   * removed client, an unknown id) is left out, so the answer never tells
   * such a key from one that doesn't exist.
   */
  async named(keys: readonly string[]): Promise<Person[]> {
    const found = await this.names(keys);
    return this.withAvatars(
      [...found].flatMap(([key, name]) =>
        name === null ? [] : [{ key, name }],
      ),
    );
  }

  /**
   * The tenant's active members (an active account, an active membership in
   * this tenant) whose name contains `q` (any case; `%` and `_` are
   * themselves), by name: for @mention autocomplete. Without `q`, the first
   * by name. API clients are not people here: a mention names a user.
   */
  async directory(q: string | undefined, limit: number): Promise<Person[]> {
    const rows = await this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, users.id),
          eq(memberships.tenantId, this.tenancy.tenantId()),
          eq(memberships.active, true),
        ),
      )
      .where(
        and(
          eq(users.active, true),
          q ? ilike(users.name, `%${escapeLike(q)}%`) : undefined,
        ),
      )
      .orderBy(asc(users.name), asc(users.id))
      .limit(limit);
    return this.withAvatars(
      rows.map((row) => ({ key: `user:${row.id}`, name: row.name })),
    );
  }

  /**
   * The tenant's units as every member sees them: id, name, parent and
   * depth, nothing else (no members). Newest first in cursor pages; `q` a
   * part of the name (any case, `%` and `_` themselves), `id` the ones to name.
   */
  async units(query: UnitsQuery) {
    const rows = await this.db
      .select({
        id: organizationalUnits.id,
        type: organizationalUnits.type,
        name: organizationalUnits.name,
        parentId: organizationalUnits.parentId,
      })
      .from(organizationalUnits)
      .where(
        and(
          query.q
            ? ilike(organizationalUnits.name, `%${escapeLike(query.q)}%`)
            : undefined,
          query.id ? inArray(organizationalUnits.id, query.id) : undefined,
          afterCursor(organizationalUnits.id, query),
        ),
      )
      .orderBy(desc(organizationalUnits.id))
      .limit(query.limit + 1);
    const page = toPage(rows, query);
    const ids = page.items.map((unit) => unit.id);
    const depths = ids.length
      ? await this.db
          .select({
            id: organizationalUnitClosure.descendantId,
            depth: max(organizationalUnitClosure.depth),
          })
          .from(organizationalUnitClosure)
          .where(inArray(organizationalUnitClosure.descendantId, ids))
          .groupBy(organizationalUnitClosure.descendantId)
      : [];
    const depthOf = new Map(depths.map((row) => [row.id, row.depth ?? 0]));
    return {
      items: page.items.map((unit): UnitRef => ({
        ...unit,
        depth: depthOf.get(unit.id) ?? 0,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * The principal behind a key, as it is now in the current tenant: an
   * active member, an active API client of the tenant; null for anyone else
   * (deactivated, gone, another tenant's). What a push to someone checks
   * their permissions with.
   */
  async principal(key: string): Promise<Principal | null> {
    const tenantId = this.tenancy.tenantId();
    const [kind, id] = key.split(':') as [string, string | undefined];
    if (!id || !UUID.test(id)) {
      return null;
    }
    if (kind === 'user') {
      const user = await this.users.inTenant(id, tenantId);
      return user?.tenantId === tenantId ? user : null;
    }
    if (kind !== 'client') {
      return null;
    }
    const [client] = await this.db
      .select()
      .from(apiClients)
      .where(eq(apiClients.id, id));
    return client?.active
      ? { kind: 'client', id: client.id, name: client.name, tenantId }
      : null;
  }
}
