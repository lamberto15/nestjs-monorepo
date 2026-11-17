import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * How long a kind of record is kept, declared by the module that owns it in
 * its own imports (`RetentionModule.forFeature()`):
 *
 * ```ts
 * RetentionModule.forFeature({
 *   name: 'note',
 *   label: 'Notes',
 *   subject: 'Note',
 *   table: notes,
 *   ageColumn: notes.createdAt,
 *   action: 'purge',
 *   defaultDays: 730,
 *   minDays: 30,
 * })
 * ```
 *
 * A rule does nothing until a tenant turns it on (`PUT /v1/retention/rules/{name}`,
 * `Access.manageRetention`); the tenant may then choose its days, not below
 * `minDays`. Records under a legal hold are never touched.
 */
export interface RetentionRule {
  /** Unique; the route's key: `note`. */
  readonly name: string;
  /** Shown to the administrator: `Notes`. */
  readonly label: string;
  /** The records' permission subject, what a legal hold names: `Note`. */
  readonly subject: string;
  /** The tenant table (it needs an `id`). */
  readonly table: PgTable & { id: AnyPgColumn };
  /** How old a record is: the column that dates it. */
  readonly ageColumn: AnyPgColumn;
  /**
   * `purge` deletes the rows (and what refers to them: `@RecordPurge()`);
   * `anonymise` keeps the rows and overwrites what identifies a person.
   */
  readonly action: 'purge' | 'anonymise';
  /** The days a tenant starts from when it turns the rule on. */
  readonly defaultDays: number;
  /** The shortest a tenant may set (default 1). */
  readonly minDays?: number;
  /** Only these rows are ever due (a closed record, say). */
  readonly where?: SQL;
  /**
   * `anonymise` only: the values written (`{ email: null }`) and the
   * condition of a row not yet written (`isNotNull(table.email)`), so a row
   * is anonymised once.
   */
  readonly anonymise?: {
    readonly set: Record<string, unknown>;
    readonly pending: SQL;
  };
}

/**
 * One rule, as `RetentionModule.forFeature()` provides it in the declaring
 * module; RetentionRules discovers every one. Serialized as its name: Nest
 * hashes a dynamic module's providers, and a rule holds tables.
 */
export class RetentionRegistration {
  constructor(readonly rule: RetentionRule) {}

  toJSON() {
    return `retention#${this.rule.name}`;
  }
}

/** The declared rules, found at startup and refused when inconsistent. */
@Injectable()
export class RetentionRules implements OnModuleInit {
  private readonly rules = new Map<string, RetentionRule>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    this.load(
      this.discovery
        .getProviders()
        .flatMap((wrapper) =>
          wrapper.instance instanceof RetentionRegistration
            ? [wrapper.instance.rule]
            : [],
        ),
    );
  }

  load(rules: readonly RetentionRule[]) {
    for (const rule of new Set(rules)) {
      if (this.rules.has(rule.name)) {
        throw new Error(`Two retention rules are named "${rule.name}".`);
      }
      if (rule.action === 'anonymise' && !rule.anonymise) {
        throw new Error(
          `The retention rule "${rule.name}" anonymises: declare what it writes (anonymise: { set, pending }).`,
        );
      }
      if (rule.defaultDays < (rule.minDays ?? 1)) {
        throw new Error(
          `The retention rule "${rule.name}" starts below its minimum.`,
        );
      }
      this.rules.set(rule.name, rule);
    }
  }

  all() {
    return [...this.rules.values()];
  }

  find(name: string) {
    return this.rules.get(name);
  }
}
