import { z } from 'zod';

/** When grants end, by role id: temporary access. Roles not listed never end. */
const roleExpiresAt = z
  .record(z.uuid(), z.iso.datetime({ offset: true }))
  .optional()
  .describe(
    'When each grant ends, by role id (temporary access); the others never do.',
  );

/** IPv4/IPv6 CIDRs; the service validates them (400 invalid_cidr) and stores them canonical. */
const allowedCidrs = z
  .array(z.string().trim().min(1).max(64))
  .max(100)
  .optional()
  .describe(
    'IPv4/IPv6 CIDRs (a bare address is /32 or /128) the client’s keys may be used from; a request from elsewhere gets 403 client_ip_not_allowed. Empty: any address. A malformed one: 400 invalid_cidr.',
  );

export const createClientSchema = z.object({
  name: z.string().trim().min(1).max(80),
  allowedCidrs,
  roleIds: z
    .array(z.uuid())
    .default([])
    .describe('Roles on top of what every client may do (clientAccess).'),
  roleExpiresAt,
  keyExpiresAt: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('When the first key stops working; leave out for never.'),
  dailyQuota: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Requests a day (UTC), set in the same transaction (the usage module; `Usage.setClientQuota`). Leave out for none.',
    ),
});

export const clientChangesSchema = z.object({
  active: z
    .boolean()
    .optional()
    .describe('false: every key is refused from the next request.'),
  allowedCidrs,
  roleIds: z.array(z.uuid()).optional(),
  roleExpiresAt,
});

// No body at all is fine: rotate with the defaults.
export const rotateSchema = z.preprocess(
  (body) => body ?? {},
  z.object({
    graceSeconds: z
      .number()
      .int()
      .min(0)
      .max(30 * 86_400)
      .default(0)
      .describe(
        'How long the current keys keep working, so the system can switch: 0 stops them now.',
      ),
    expiresAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('When the new key stops working.'),
  }),
);

const keyViewSchema = z.object({
  id: z.uuid(),
  keyId: z
    .string()
    .describe("The key's public id: the middle of <prefix>_<id>_<secret>."),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso
    .datetime()
    .nullable()
    .describe('Recorded at most once a minute.'),
});

export const clientViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  active: z.boolean(),
  allowedCidrs: z
    .array(z.string())
    .describe('CIDRs its keys may be used from; empty: any address.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  keys: z
    .array(keyViewSchema)
    .describe('Never the keys themselves, nor their hashes.'),
  roles: z.array(
    z.object({ roleId: z.uuid(), expiresAt: z.iso.datetime().nullable() }),
  ),
});

export const clientWithKeySchema = clientViewSchema.extend({
  key: z
    .string()
    .describe('The API key: `Authorization: Bearer <key>`. Shown this once.'),
});
