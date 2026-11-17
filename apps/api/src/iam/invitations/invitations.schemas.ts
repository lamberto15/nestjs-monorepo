import { z } from 'zod';
import { newPassword } from '../account/account.schemas.js';

const roleExpiresAt = z
  .record(z.uuid(), z.iso.datetime({ offset: true }))
  .optional()
  .describe(
    'When each grant ends, by role id (temporary access); the others never do.',
  );

// Strict: a `password` (or `name` on a change) is refused, not ignored:
// administrators never set another person's account.
const invitationName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe('The name a new account starts with; its owner changes it.');
const unitIds = z
  .array(z.uuid())
  .describe('The organizational units the user will belong to, as a member.');

export const inviteSchema = z.strictObject({
  email: z
    .email()
    .optional()
    .describe(
      'Where the link goes; a prepared member (`send: false`) may get it later.',
    ),
  name: invitationName.optional(),
  roleIds: z.array(z.uuid()).default([]),
  roleExpiresAt,
  unitIds: unitIds.optional(),
  send: z
    .boolean()
    .default(true)
    .describe(
      'true (invite): the link is mailed now. false (prepare): no link until POST /access/invitations/{id}/send.',
    ),
});

export const updateInvitationSchema = z.strictObject({
  email: z
    .email()
    .nullable()
    .optional()
    .describe('A new address withdraws a sent link: send again.'),
  name: invitationName.nullable().optional(),
  roleIds: z.array(z.uuid()).optional(),
  roleExpiresAt,
  unitIds: unitIds.optional(),
});

export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string().nullable().describe('null: prepared without one.'),
  status: z
    .enum(['prepared', 'sent', 'expired'])
    .describe(
      '`prepared`: no link yet (send it); `sent`: its link works until `expiresAt`; `expired`: send it again.',
    ),
  expiresAt: z.iso
    .datetime()
    .nullable()
    .describe("The link's end; null: prepared."),
});

export const pendingInvitationSchema = invitationSchema.extend({
  name: z.string().nullable(),
  roleIds: z.array(z.uuid()),
  roleExpiresAt: z
    .record(z.uuid(), z.iso.datetime({ offset: true }))
    .describe(
      'When each grant ends once accepted, by role id; the others never do.',
    ),
  unitIds: z.array(z.uuid()),
  invitedBy: z.string(),
  sentAt: z.iso
    .datetime()
    .nullable()
    .describe('When its current link was sent; null: prepared.'),
  createdAt: z.iso.datetime(),
});

export const acceptSchema = z.object({
  token: z.string().min(1).max(200).describe("The link's token."),
  password: newPassword
    .optional()
    .describe('A new address chooses its password here.'),
  name: invitationName.optional(),
});

export const acceptedInvitationSchema = z.object({
  tenantId: z.uuid(),
  accountCreated: z
    .boolean()
    .describe(
      'true: a new account was made; sign in with the password just chosen.',
    ),
});
