import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { AnyField, FieldKind } from '../fields/field.js';
import type { RecordDeclaration } from '../records/record.js';
import {
  compileExpression,
  type Expression,
  type ExpressionType,
} from '../expressions/expression.js';
import type { QualitySeverity } from './data-quality.tables.js';

/** A rule written in the expression language: it holds while `expect` is true. */
export interface QualityRule {
  /** Names its findings (their `field`): lower case words, `done-has-body`. */
  name: string;
  /** A bool expression over the record's fields, as the API shows them (modules/expressions). A finding when it is `false`; an empty input makes it null, which the `missing` check is for. */
  expect: string;
  /** Default `suggestion`. */
  severity?: QualitySeverity;
  /** What helps to fix it, shown with the finding. */
  message?: string;
}

/** The checks a record declares (`DataQualityModule.forRecord(RECORD, checks)`); its `ref` fields are always checked. */
export interface QualityChecks {
  /** Fields that should hold a value: empty (null, or blank text) is a suggestion. */
  recommended?: readonly string[];
  /** Fields whose value (whatever its case) another record having too makes them duplicate candidates. */
  duplicates?: readonly string[];
  rules?: readonly QualityRule[];
}

const RULE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The expression type of a field kind; none for the ones rules can't read. */
const TYPES: Partial<Record<FieldKind, ExpressionType>> = {
  string: 'string',
  text: 'string',
  enum: 'string',
  ref: 'string',
  int: 'int',
  decimal: 'decimal',
  money: 'money',
  bool: 'bool',
  date: 'date',
  datetime: 'datetime',
};

/** A kind whose value is text: blank text counts as empty, and two may be the same value. */
export const TEXTS: readonly FieldKind[] = ['string', 'text', 'enum'];

/** A rule, compiled once when the module is declared (a mistake fails the app's start). */
export interface CompiledRule extends QualityRule {
  compiled: Expression;
}

/**
 * One record's checks, provided by `DataQualityModule.forRecord()`; the
 * registry finds every one at startup. Refuses at once what could never
 * work: an unknown field, one that can't be checked, a rule that doesn't
 * compile or isn't a bool.
 */
export class DataQualityRegistration {
  readonly recommended: readonly string[];
  readonly duplicates: readonly string[];
  readonly rules: readonly CompiledRule[];

  constructor(
    readonly record: RecordDeclaration,
    checks: QualityChecks,
  ) {
    const fields = record.fields as Record<string, AnyField>;
    const known = (check: string, name: string) => {
      const kind = fields[name]?.kind;
      if (!kind || kind === 'money' || kind === 'json') {
        throw new Error(
          `${record.subject}: ${check} "${name}" is no field that can be checked.`,
        );
      }
      return kind;
    };
    this.recommended = checks.recommended ?? [];
    this.duplicates = checks.duplicates ?? [];
    this.recommended.forEach((name) => known('recommended', name));
    this.duplicates.forEach((name) => {
      if (!TEXTS.includes(known('duplicates', name))) {
        throw new Error(
          `${record.subject}: duplicates "${name}" must be a text field.`,
        );
      }
    });
    const variables = Object.fromEntries(
      Object.entries(fields).flatMap(([name, f]) =>
        TYPES[f.kind] ? [[name, TYPES[f.kind]!]] : [],
      ),
    ) as Record<string, ExpressionType>;
    const seen = new Set<string>();
    this.rules = (checks.rules ?? []).map((rule) => {
      if (!RULE_NAME.test(rule.name) || seen.has(rule.name)) {
        throw new Error(
          `${record.subject}: rule "${rule.name}" needs a unique name in lower case words joined by "-".`,
        );
      }
      seen.add(rule.name);
      const compiled = compileExpression(rule.expect, variables);
      if (compiled.type !== 'bool') {
        throw new Error(
          `${record.subject}: rule "${rule.name}" must be a bool expression, not ${compiled.type}.`,
        );
      }
      return { ...rule, compiled };
    });
  }

  get subject() {
    return this.record.subject;
  }

  /** Nest hashes a dynamic module's providers: the subject names this one. */
  toJSON() {
    return `data-quality:${this.record.subject}`;
  }
}

/** Every record with data-quality checks, found at startup. */
@Injectable()
export class DataQualityRegistry implements OnModuleInit {
  private readonly registrations = new Map<string, DataQualityRegistration>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders()) {
      const found: unknown = wrapper.instance;
      if (!(found instanceof DataQualityRegistration)) continue;
      const known = this.registrations.get(found.subject);
      if (known && known !== found) {
        throw new Error(
          `Two data-quality registrations are for ${found.subject}.`,
        );
      }
      this.registrations.set(found.subject, found);
    }
  }

  find(subject: string) {
    return this.registrations.get(subject);
  }

  /** Every registration, by subject. */
  all() {
    return [...this.registrations.values()].sort((a, b) =>
      a.subject.localeCompare(b.subject),
    );
  }
}
