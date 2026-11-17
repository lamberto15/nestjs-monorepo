import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { AccessContext, Condition } from '../access/permissions.js';

/** A condition on a record's unit column: one of the principal's units (AccessContext) by `ids`. */
const unitCondition =
  (text: string, ids: (context: AccessContext) => readonly string[]) =>
  (column: AnyPgColumn): Condition => ({
    text,
    where: (_principal, _params, context) => [[column, ids(context)]],
  });

/**
 * Conditions on records whose `column` holds an organizational unit, for
 * a subject's `conditions`. They read the units loaded with the
 * principal's permissions (the organization module's @UnitDirectory()),
 * so a record and a list are checked against the same ids. API clients
 * and system jobs have none: these match nothing for them. A unit's type
 * grants nothing: only membership and leading do.
 *
 * ```ts
 * conditions: { inMyUnits: inMyUnits(notes.unitId) }
 * ```
 *
 * `inMyUnits`: the units the user is a current member of, not those below.
 */
export const inMyUnits = unitCondition(
  'inMyUnits',
  (context) => context.directUnitIds,
);

/** The user's units and every unit below them: a member of "Sales" sees what "Sales / North" owns. */
export const inMyUnitsAndBelow = unitCondition(
  'inMyUnitsAndBelow',
  (context) => context.unitIdsAndBelow,
);

/** The units the user currently leads and every unit below them. */
export const inUnitsILeadAndBelow = unitCondition(
  'inUnitsILeadAndBelow',
  (context) => context.ledUnitIdsAndBelow,
);
