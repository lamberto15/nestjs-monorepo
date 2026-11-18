import { z } from 'zod';
import { CONSENT_KIND_PATTERN } from './consent-kinds.js';

export const deletionSchema = z.object({
  requestedAt: z.iso.datetime(),
  scheduledFor: z.iso
    .datetime()
    .describe('When the account is deleted, unless cancelled before.'),
});

export const consentSchema = z.object({
  kind: z.string().meta({ example: 'terms' }),
  version: z
    .string()
    .meta({ example: '2026-01' })
    .describe('The version accepted last.'),
  acceptedAt: z.iso.datetime().describe('When it was accepted last.'),
  withdrawnAt: z.iso
    .datetime()
    .nullable()
    .describe('When it was withdrawn; null: in force.'),
});

export const consentKindSchema = z.object({
  kind: z.string().meta({ example: 'marketing' }),
  version: z
    .string()
    .describe(
      'The version in force: the only one POST /v1/account/consents accepts.',
    ),
  required: z
    .boolean()
    .describe(
      'Needed to use the service: it cannot be withdrawn, only the account deleted.',
    ),
  label: z.string().describe("In the request's language."),
  description: z.string().describe("In the request's language."),
});

export const accountStateSchema = z.object({
  deletion: deletionSchema
    .nullable()
    .describe('A pending deletion of this account, or null.'),
  consents: z.array(consentSchema),
});

export const requestDeletionSchema = z
  .object({
    password: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe('Your current password: required when the account has one.'),
  })
  .strict();

export const cancelDeletionByLinkSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(2048)
      .describe("The `token` of the deletion mail's cancel link."),
  })
  .strict();

export const acceptConsentSchema = z
  .object({
    kind: z
      .string()
      .trim()
      .regex(CONSENT_KIND_PATTERN, 'a name: terms, privacy, marketing')
      .meta({ example: 'terms' }),
    version: z.string().trim().min(1).max(50).meta({ example: '2026-01' }),
  })
  .strict();
