import { z } from 'zod';

/** What the access API answers with (its routes' OpenAPI responses, the typed client's types). */

const conditionSchema = z.object({
  key: z.string().meta({ example: 'mine' }),
  params: z.record(z.string(), z.unknown()).optional(),
});

/** A member of the tenant, as GET /access/users lists them. */
export const userViewSchema = z.object({
  id: z.uuid(),
  kind: z.literal('user'),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  locale: z.string().nullable().describe('The language they chose, or null.'),
  timezone: z
    .string()
    .nullable()
    .describe('Their IANA time zone, or null (APP_TIMEZONE).'),
  active: z
    .boolean()
    .describe('The membership in this tenant and the account, together.'),
  hasPassword: z
    .boolean()
    .describe('false: invited, or signs in only with a provider.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  roleIds: z.array(z.uuid()),
  roles: z.array(
    z.object({
      roleId: z.uuid(),
      expiresAt: z.iso
        .datetime()
        .nullable()
        .describe('When the grant ends; null: never.'),
    }),
  ),
  unitIds: z
    .array(z.uuid())
    .describe('The organizational units they are a current member of.'),
  managedByScim: z
    .boolean()
    .describe(
      "The tenant's identity provider provisions them over SCIM: their account and membership change there.",
    ),
  avatarUrl: z
    .string()
    .nullable()
    .describe('Their picture (`GET /v1/people/{id}/avatar?v=…`); null: none.'),
});

/** A role of the tenant, with its permissions and how many users hold it. */
export const roleViewSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  key: z
    .string()
    .nullable()
    .describe(
      "The code's name of a built-in or seeded role (`administrator`, `editor`); null for roles made through the API.",
    ),
  name: z.string(),
  description: z.string(),
  system: z.boolean().describe('Built in: never edited nor deleted.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  permissions: z.array(
    z.object({
      subject: z.string(),
      action: z.string(),
      conditions: z.array(conditionSchema),
      fields: z
        .array(z.string())
        .optional()
        .describe('Only these restrictable fields; absent: all of them.'),
    }),
  ),
  members: z.int().describe('The users who hold it.'),
});

export const createdRoleSchema = z.object({ id: z.uuid() });

/** GET /access/catalog: every permission that exists, and the system jobs. */
export const catalogSchema = z.object({
  subjects: z.array(
    z.object({
      subject: z.string().meta({ example: 'Note' }),
      label: z.string(),
      fields: z
        .array(
          z.object({
            field: z.string(),
            label: z.string(),
            sensitive: z
              .boolean()
              .describe('Redacted in the audit log and revisions.'),
          }),
        )
        .describe('The fields a permission may grant one by one.'),
      actions: z.array(
        z.object({
          action: z.string().meta({ example: 'read' }),
          label: z.string(),
          conditions: z.array(
            z.object({
              key: z.string(),
              label: z.string(),
              description: z.string(),
              input: z
                .object({
                  name: z.string(),
                  label: z.string(),
                  type: z.enum(['text', 'cents']),
                })
                .nullable()
                .describe('The parameter the condition takes, if any.'),
            }),
          ),
        }),
      ),
    }),
  ),
  systemJobs: z.array(
    z.object({
      key: z.string(),
      actor: z
        .string()
        .describe('`system:<key>`: the actor of its audit entries.'),
      label: z.string(),
      description: z.string(),
      permissions: z.array(
        z.object({
          subject: z.string(),
          action: z.string(),
          conditions: z.array(conditionSchema),
          fields: z.array(z.string()).nullable(),
        }),
      ),
    }),
  ),
});

/** A user or an API client of the tenant, as a picker shows it (GET /access/principals). */
export const principalSchema = z.object({
  id: z.uuid(),
  key: z
    .string()
    .describe(
      "The principal's key: `user:<id>` or `client:<id>`, as `scopeId` of a setting's user scope and `actor` filters take it.",
    )
    .meta({ example: 'user:0190a1b2-0000-7000-8000-000000000000' }),
  kind: z.enum(['user', 'client']),
  label: z.string().describe("The user's name, or the client's."),
  email: z.string().nullable().describe("A user's address; null for a client."),
  active: z
    .boolean()
    .describe(
      'A user: the membership in this tenant and the account; a client: not revoked.',
    ),
});

/** GET /access/users/{id}/explanation's query. */
export const explainQuerySchema = z
  .object({
    subject: z
      .string()
      .min(1)
      .max(100)
      .describe('A subject of the catalog (GET /access/catalog).')
      .meta({ example: 'Note' }),
    recordId: z
      .uuid()
      .optional()
      .describe(
        'One of its records, looked up as you; left out: on any record (some at least).',
      ),
  })
  .strict();

/** A yes, a no, or `null`: withheld, a field hidden from you decides it. */
const verdict = z.boolean().nullable();

/** Why a member may or may not act on a subject or a record (GET /access/users/{id}/explanation). */
export const explanationSchema = z.object({
  user: z.object({ id: z.uuid(), name: z.string(), email: z.string() }),
  subject: z.string(),
  recordId: z.uuid().nullable(),
  roles: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        expiresAt: z.iso.datetime().nullable(),
        expired: z.boolean().describe('An ended grant: it counts for nothing.'),
      }),
    )
    .describe("The member's role grants, ended ones too."),
  units: z
    .object({
      direct: z.array(z.uuid()),
      andBelow: z.array(z.uuid()),
      andAbove: z.array(z.uuid()),
      ledAndBelow: z.array(z.uuid()),
    })
    .describe(
      'Their current units, as `inMyUnits`, `inMyUnitsAndBelow`, `inMyUnitsAndAbove` and `inUnitsILeadAndBelow` read them.',
    ),
  actions: z.array(
    z.object({
      action: z.string(),
      allowed: verdict.describe(
        'With a record: on it; without: on some records at least.',
      ),
      fields: z
        .array(z.string())
        .nullable()
        .describe(
          'The declared fields it may touch (with a record: on it); null: withheld.',
        ),
      grants: z
        .array(
          z.object({
            roleId: z
              .uuid()
              .nullable()
              .describe('The role it comes with; null: built in.'),
            expiresAt: z.iso.datetime().nullable(),
            all: z
              .boolean()
              .describe('`all.manage`: anything (an administrator).'),
            fields: z
              .array(z.string())
              .nullable()
              .describe('Only these declared fields; null: all.'),
            matches: verdict.describe(
              'Whether it reaches the record (always true without one).',
            ),
            conditions: z.array(
              conditionSchema.extend({
                params: z.record(z.string(), z.unknown()).nullable(),
                matches: verdict,
              }),
            ),
          }),
        )
        .describe("The permissions of the member's roles for this action."),
    }),
  ),
});
