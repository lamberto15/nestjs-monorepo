import { DiscoveryService } from '@nestjs/core';

/** Whom a section is asked about, and where. */
export interface PersonalDataSubject {
  userId: string;
  /** `user:<id>`: how the person appears as an owner, an actor, a recipient. */
  key: string;
  /** The tenant this call runs in (its queries are bound to it); null: the account's own, in no tenant. */
  tenantId: string | null;
}

/** One record of a section, as the export writes it. */
export type PersonalRow = Record<string, unknown>;

/**
 * What a module holds about a person, for their data export and their
 * account's deletion: mark one provider `@PersonalData({ name, scopes })`
 * (README.md). Every method runs in the scope it is asked for, in a
 * transaction of its own for `erase`: the module's queries just run.
 */
export interface PersonalDataSection {
  /** The person's rows in this scope: one batch, or batches. */
  rows?(
    subject: PersonalDataSubject,
  ): Promise<PersonalRow[]> | AsyncIterable<PersonalRow[]>;
  /**
   * At the deletion: remove or anonymise what identifies the person in
   * this scope. Business records usually stay, without the name.
   */
  erase?(subject: PersonalDataSubject): Promise<void>;
}

export interface PersonalDataOptions {
  /** The section's name in the export (`favorites`); unique. */
  name: string;
  /**
   * Where its rows live: `tenant` (asked once per tenant the person
   * belongs to, in that tenant), `account` (once, in no tenant: global
   * tables and rows of no tenant), or both.
   */
  scopes: readonly ('tenant' | 'account')[];
}

/** Marks a provider that implements PersonalDataSection. */
export const PersonalData =
  DiscoveryService.createDecorator<PersonalDataOptions>();
