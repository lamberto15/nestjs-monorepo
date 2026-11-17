import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { NextNumberOptions } from './sequences.service.js';
import { DATE_PARTS, type DateValues } from './naming-pattern.js';

/**
 * A subject whose records take a number, registered with
 * `SequencesModule.forFeature({ subjects: [...] })` in the module that
 * numbers it. Naming series can only be made for a registered subject (400).
 */
export interface NumberedSubject {
  /** The records' permission subject: `Note`. */
  readonly subject: string;
  /** The `sequences` name its counters take: `note`. */
  readonly sequence: string;
  /** The format in code, used while the tenant has no series of the subject. */
  readonly declared: Pick<
    NextNumberOptions,
    'prefix' | 'perYear' | 'width' | 'separator'
  >;
  /**
   * The create body's fields a series may print (`{customer}`), take its
   * date from (`dateField`) or test (`conditions`), by kind; `boolean`
   * ones only in conditions. None: a series uses dates and variables only.
   */
  readonly fields?: Readonly<Record<string, NumberingFieldKind>>;
}

/** A field as numbering reads it from a create body. */
export type NumberingFieldKind =
  'text' | 'number' | 'date' | 'datetime' | 'boolean';

/** What a variable is resolved for: one record's number, at its date. */
export interface NamingContext {
  /** The record's subject: `Note`. */
  readonly subject: string;
  /** The moment its date parts are taken at: now, or its date field's. */
  readonly at: Date;
  readonly date: DateValues;
  /** The create body's values, as the API takes them. */
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * A value every pattern may print (`.FY.` or `{FY}`), as Frappe's
 * `naming_series_variables` hook adds them: FY and ABBR are this module's;
 * a feature declares its own in `SequencesModule.forFeature({ variables })`.
 */
export interface NamingVariable {
  /** Upper case, as patterns write it: `REGION`. */
  readonly name: string;
  /** What it prints, for the admin page: "The fiscal year: 2026-2027". */
  readonly description: string;
  /** What it prints for a record; refused with a 400 when it prints nothing. */
  readonly resolve: (context: NamingContext) => string | Promise<string>;
}

/** Ids of registered lists: what Nest hashes for each forFeature() module. */
const ids = new WeakMap<object, number>();
let lastId = 0;

/**
 * One module's subjects and variables, as `SequencesModule.forFeature()`
 * provides them in that module; the registry discovers every one.
 * Serialized as a number: Nest hashes a dynamic module's providers, and a
 * variable holds a function.
 */
export class NumberingRegistration {
  constructor(
    readonly subjects: readonly NumberedSubject[],
    readonly variables: readonly NamingVariable[],
  ) {
    if (!ids.has(subjects)) ids.set(subjects, ++lastId);
  }

  toJSON() {
    return `numbering#${ids.get(this.subjects)}`;
  }
}

const NAME = /^[A-Z][A-Z0-9_]*$/;

@Injectable()
export class NamingSeriesRegistry implements OnModuleInit {
  private readonly subjects = new Map<string, NumberedSubject>();
  private readonly variables = new Map<string, NamingVariable>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders()) {
      if (wrapper.instance instanceof NumberingRegistration) {
        wrapper.instance.subjects.forEach((each) => this.register(each));
        wrapper.instance.variables.forEach((each) => this.declare(each));
      }
    }
  }

  /** Registers a numbered subject (the same declaration twice is harmless; two differing are a mistake). */
  register(numbered: NumberedSubject) {
    const known = this.subjects.get(numbered.subject);
    if (known && known.sequence !== numbered.sequence) {
      throw new Error(`Two numbered subjects are "${numbered.subject}".`);
    }
    this.subjects.set(numbered.subject, numbered);
  }

  /** The registered subject, or undefined. */
  find(subject: string): NumberedSubject | undefined {
    return this.subjects.get(subject);
  }

  /** Every numbered subject. */
  all() {
    return [...this.subjects.values()];
  }

  declare(variable: NamingVariable) {
    if (!NAME.test(variable.name)) {
      throw new Error(
        `Naming variable "${variable.name}": upper-case letters, digits and "_", a letter first.`,
      );
    }
    if ((DATE_PARTS as readonly string[]).includes(variable.name)) {
      throw new Error(
        `Naming variable "${variable.name}" is a date part already.`,
      );
    }
    const known = this.variables.get(variable.name);
    if (known && known.description !== variable.description) {
      throw new Error(`Two naming variables are "${variable.name}".`);
    }
    this.variables.set(variable.name, variable);
  }

  variable(name: string) {
    return this.variables.get(name);
  }

  allVariables() {
    return [...this.variables.values()];
  }

  variableNames(): ReadonlySet<string> {
    return new Set(this.variables.keys());
  }
}
