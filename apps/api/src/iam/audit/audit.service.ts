import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { Database } from '../../core/database/database.js';
import { and, type SQL } from 'drizzle-orm';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  type PageQuery,
  toPage,
} from '../../core/http/pagination.js';
import { discoverOne } from '../auth/discover.js';
import { actorOf, type Principal } from '../auth/principal.js';
import { currentAuditRun } from './audit-run.js';
import { ActorNameSource, type ActorNames } from './actor-names.js';
import { auditLog } from './audit.tables.js';

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  /** The run it is part of; default: the current one (inAuditRun()). */
  runId?: string;
}

/**
 * The audit log: who did what. An entry joins the current transaction
 * (`@InjectTransaction()`), so it commits with the change it records, or
 * not at all; `db` names another. It lands in the tenant of the work that
 * records it, or in none outside every tenant (an account's own entries).
 */
@Injectable()
export class AuditService implements OnModuleInit {
  private actorNames?: ActorNames;

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly discovery: DiscoveryService,
  ) {}

  onModuleInit() {
    this.actorNames = discoverOne<ActorNames>(
      this.discovery,
      ActorNameSource,
      'actor names (@ActorNameSource())',
    );
  }

  async record(
    principal: Principal | null,
    entry: AuditEntry,
    db: Database = this.db,
  ) {
    await db.insert(auditLog).values({
      ...actorOf(principal),
      ...fieldsOf(entry),
    });
  }

  /** For a sign-in attempt, before anyone is signed in: `label` is what they typed. */
  async recordAnonymous(
    label: string,
    entry: AuditEntry,
    db: Database = this.db,
  ) {
    await db.insert(auditLog).values({
      actor: 'anonymous',
      actorLabel: label,
      ...fieldsOf(entry),
    });
  }

  /**
   * The account itself acting without a session, through a link it was
   * mailed (a deletion cancelled): the actor is `user:<id>`, labelled with
   * its address, as if it had signed in.
   */
  async recordAccount(
    account: { id: string; email: string },
    entry: AuditEntry,
    db: Database = this.db,
  ) {
    await db.insert(auditLog).values({
      actor: `user:${account.id}`,
      actorLabel: account.email,
      ...fieldsOf(entry),
    });
  }

  /** A page of the log, newest first unless the query sorts (the tenant's, by row-level security). */
  async page(query: PageQuery, where?: SQL) {
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(auditLog)
        .where(and(where, afterCursor(auditLog.id, query)))
        .orderBy(...pageOrder(auditLog.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, auditLog, where, query),
    ]);
    return toPage(rows, query, total);
  }

  /**
   * Entries with their actor's name now (`actorName`), named in one round
   * for the page (ActorNames); null for the others (`anonymous`,
   * `system:<key>`, a deleted account). `actorLabel` stays what the entry
   * stored when it was written.
   */
  async withActorNames<T extends { actor: string }>(
    entries: readonly T[],
  ): Promise<(T & { actorName: string | null })[]> {
    const names =
      this.actorNames && entries.length
        ? await this.actorNames.names(entries.map((entry) => entry.actor))
        : new Map<string, string | null>();
    return entries.map((entry) => ({
      ...entry,
      actorName: names.get(entry.actor) ?? null,
    }));
  }
}

const fieldsOf = (entry: AuditEntry) => ({
  action: entry.action,
  targetType: entry.targetType ?? null,
  targetId: entry.targetId ?? null,
  details: entry.details ?? null,
  ip: entry.ip ?? null,
  runId: entry.runId ?? currentAuditRun() ?? null,
});
