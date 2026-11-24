import { z } from 'zod';

export const tenantSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  active: z.boolean(),
  operator: z.boolean().describe("The operators' tenant."),
  createdBySignUp: z
    .boolean()
    .describe('Made by a self sign-up (TENANT_SIGN_UP), not by the operators.'),
  deletionRequestedAt: z.iso
    .datetime()
    .nullable()
    .describe('An operator asked for its deletion; null: none pending.'),
  deletionScheduledFor: z.iso
    .datetime()
    .nullable()
    .describe('When it is erased, unless cancelled before.'),
  deletionStartedAt: z.iso
    .datetime()
    .nullable()
    .describe('The erase began: it can no longer be cancelled.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const tenantName = z.string().trim().min(1).max(120);

const tenantSlug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(48)
  .describe('A short handle: lowercase letters, digits and dashes (`acme`).');

export const createTenantSchema = z.object({
  name: tenantName,
  slug: tenantSlug,
  administratorEmail: z
    .email()
    .describe('Its first administrator, invited at this address.'),
});

export const createdTenantSchema = tenantSchema.extend({
  administrator: z.object({
    email: z.string(),
    status: z
      .enum(['invited'])
      .describe(
        'Always `invited`: whether the address has an account is never read here, so never told.',
      ),
    expiresAt: z.iso.datetime().describe('When the link stops working.'),
  }),
});

export const updateTenantSchema = z
  .strictObject({
    name: tenantName.optional(),
    slug: tenantSlug.optional(),
    active: z
      .boolean()
      .optional()
      .describe(
        'false: nobody acts in it (its sessions end, API keys stop, connections close, jobs are skipped); true: its data, members and keys are back. Never for the operator tenant.',
      ),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one of name, slug, active.',
  });

export const requestDeletionSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(48)
    .describe("The tenant's slug, typed again: what you mean to delete."),
});

export const signUpSchema = z.object({
  email: z.string().trim().pipe(z.email()).meta({ example: 'ada@example.com' }),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(128),
  locale: z.string().min(2).max(35).optional(),
  timezone: z.string().min(1).max(64).optional(),
  tenantName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe(
      'With TENANT_SIGN_UP: the name of the tenant you make (your name without one).',
    ),
});

export const signedUpSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  tenantId: z
    .uuid()
    .nullable()
    .describe('The tenant it joined (TENANCY=single), else null.'),
});

export const domainSchema = z.object({
  id: z.uuid(),
  hostname: z.string(),
  verified: z.boolean(),
  verifiedAt: z.iso.datetime().nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  record: z
    .object({
      type: z.literal('TXT'),
      name: z.string(),
      value: z.string(),
    })
    .describe('The DNS record to publish, then ask for the check.'),
  createdAt: z.iso.datetime(),
});

export const domainsSchema = z.object({
  enabled: z.boolean().describe('CUSTOM_DOMAINS is on in this deployment.'),
  items: z.array(domainSchema),
});

export const createDomainSchema = z.object({
  hostname: z.string().min(1).max(300).meta({ example: 'app.acme.com' }),
});

export const myTenantSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  operator: z
    .boolean()
    .describe(
      "The operators' tenant (OPERATOR_TENANT): its members run the deployment.",
    ),
  current: z.boolean().describe('The tenant this session or token acts in.'),
});

export const switchSchema = z.object({
  tenantId: z.uuid().describe('One of GET /auth/tenants.'),
});
