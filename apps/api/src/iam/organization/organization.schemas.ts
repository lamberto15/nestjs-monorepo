import { z } from 'zod';
import { IMPACT_USERS_LIMIT } from './organization.service.js';
import { UNIT_ROLES, UNIT_TYPES } from './organization.tables.js';

export const unitSchema = z.object({
  id: z.uuid(),
  type: z
    .enum(UNIT_TYPES)
    .describe('A label of the unit: it grants nothing by itself.'),
  name: z.string(),
  parentId: z.uuid().nullable(),
  depth: z.number().int().describe('0 for a top-level unit.'),
  members: z.number().int().describe('Its current members (leads included).'),
  managedByScim: z
    .boolean()
    .describe(
      "The tenant's identity provider manages it over SCIM: its name, place and members change there (409 `unit_managed_by_scim` here).",
    ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const unitRowSchema = unitSchema.omit({
  depth: true,
  members: true,
  managedByScim: true,
});
const name = z.string().trim().min(1).max(120);
export const createSchema = z.object({
  type: z.enum(UNIT_TYPES),
  name: name.describe('Unique among its siblings, ignoring case.'),
  parentId: z
    .uuid()
    .nullable()
    .optional()
    .describe('Leave out for a top-level unit.'),
});
export const updateSchema = z.object({
  type: z.enum(UNIT_TYPES).optional(),
  name: name.optional(),
  parentId: z
    .uuid()
    .nullable()
    .optional()
    .describe('Moves the unit, with every unit under it; null: to the top.'),
});
export const membershipSchema = z.object({
  id: z.uuid(),
  unitId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(UNIT_ROLES),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable().describe('Null: open-ended.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const unitMemberSchema = membershipSchema.extend({
  name: z.string().describe('The name on their account.'),
  email: z.string(),
});
export const addMemberSchema = z.object({
  userId: z.uuid(),
  role: z.enum(UNIT_ROLES).optional().describe('Default: member.'),
  validFrom: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Default: now. Later: dated ahead (a re-org).'),
  validTo: z.iso
    .datetime({ offset: true })
    .nullable()
    .optional()
    .describe('Default: open-ended.'),
});
export const changeMemberSchema = z.object({ role: z.enum(UNIT_ROLES) });
const reachChangeSchema = z.object({
  gains: z.array(z.uuid()).describe('Units they would reach and do not now.'),
  loses: z.array(z.uuid()).describe('Units they reach now and would not.'),
});
export const impactSchema = z.object({
  changes: z
    .array(
      z.object({
        userId: z.uuid(),
        name: z.string(),
        email: z.string(),
        andBelow: reachChangeSchema.describe(
          'What `inMyUnitsAndBelow` would reach.',
        ),
        andAbove: reachChangeSchema.describe(
          'What `inMyUnitsAndAbove` would reach.',
        ),
        ledAndBelow: reachChangeSchema.describe(
          'What `inUnitsILeadAndBelow` would reach.',
        ),
      }),
    )
    .describe('Only the users whose reach would change.'),
  truncated: z
    .boolean()
    .describe(
      `More than ${IMPACT_USERS_LIMIT} users could be affected: only the first were compared.`,
    ),
});
