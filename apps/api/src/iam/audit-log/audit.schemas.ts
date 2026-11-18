import { z } from 'zod';
import { pageSchema } from '../../core/http/pagination.js';

/** An entry of the audit log. */
export const auditEntrySchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid().nullable(),
    at: z.iso.datetime(),
    actor: z
      .string()
      .describe('`user:<id>`, `client:<id>`, `system:<key>` or `anonymous`.'),
    actorLabel: z
      .string()
      .describe(
        "What the entry stored of its actor when it was written: a user's address (`admin@… as ada@…` while impersonating), an API client's name, the system job's, or `anonymous`.",
      ),
    actorName: z
      .string()
      .nullable()
      .describe(
        "The actor's name now: a member or former member of the tenant, or an API client of it (one lookup for the page). Null for `system:<key>`, `anonymous`, a deleted account or a removed client: show `actorLabel` then.",
      )
      .meta({ example: 'Ada Lovelace' }),
    action: z.string().meta({ example: 'note.created' }),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    details: z.record(z.string(), z.unknown()).nullable(),
    ip: z.string().nullable(),
    runId: z
      .uuid()
      .nullable()
      .describe(
        'The bulk run the entry is part of (its `bulk.started` entry has none and targets the run: `targetType` `bulk`, `targetId` the run id). List a run with `runId=<id>`; leave runs out with `runId.isNull=true`.',
      ),
  })
  .meta({ id: 'AuditEntry' });

/** A page of the audit log (GET /v1/access/audit). */
export const auditPageSchema = pageSchema(auditEntrySchema).meta({
  id: 'AuditPage',
});

/** A sign-in of a member of the tenant (GET /v1/access/sign-ins). */
export const signInEntrySchema = z
  .object({
    id: z.uuid(),
    at: z.iso.datetime(),
    user: z.string().describe('The account: `user:<id>`.'),
    userLabel: z
      .string()
      .describe('What the entry stored of the account: its address.'),
    userName: z
      .string()
      .nullable()
      .describe("The member's name now; null for a former member."),
    result: z.enum(['success', 'failure']),
    method: z
      .string()
      .nullable()
      .meta({ example: 'password' })
      .describe(
        '`password`, `magic-link`, `passkey` or `oidc:<provider>`; a failure is a wrong password.',
      ),
    via: z
      .string()
      .nullable()
      .describe('`token`: a token client (POST /auth/token), else a browser.'),
    userAgent: z
      .string()
      .nullable()
      .describe('The device, without versions: `Chrome on macOS`.'),
    ip: z.string().nullable(),
  })
  .meta({ id: 'SignInEntry' });

/** A page of the sign-in log (GET /v1/access/sign-ins). */
export const signInPageSchema = pageSchema(signInEntrySchema).meta({
  id: 'SignInPage',
});
