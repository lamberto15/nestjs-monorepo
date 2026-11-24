import { Injectable } from '@nestjs/common';
import type { ListQuery } from '../../core/http/list-query.js';
import { PRINCIPAL_LIST } from './access.lists.js';
import { MembersRepository } from './members.repository.js';

/** A user or an API client, as a picker shows it. */
export interface PrincipalView {
  id: string;
  /** The principal's key, as settings' overrides and `actor` filters take it. */
  key: string;
  kind: 'user' | 'client';
  /** The user's name, or the client's. */
  label: string;
  /** A user's address; null for a client. */
  email: string | null;
  /** The membership in this tenant and the account (a user), or the client. */
  active: boolean;
}

/**
 * The principals of the current tenant: its members (through their
 * memberships, as GET /access/users) and its API clients (row-level
 * security), one page of both. Nothing more of them than the two lists
 * show the same callers.
 */
@Injectable()
export class PrincipalsService {
  constructor(private readonly repository: MembersRepository) {}

  /** A page of the tenant's principals, with the fields it picks. */
  async page(query: ListQuery) {
    const page = await this.repository.principalsPage(query);
    return PRINCIPAL_LIST.pick(
      {
        ...page,
        items: page.items.map((row): PrincipalView => ({
          ...row,
          key: `${row.kind}:${row.id}`,
        })),
      },
      query,
    );
  }
}
