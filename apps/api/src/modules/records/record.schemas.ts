import { z } from 'zod';
import { fieldSchemas } from '../fields/fields.js';
import type { RecordDeclaration } from './record.js';

/**
 * What a record says the reader may do with it now (`?include=can`): each
 * action the policy check its route makes. Optional: only with the include.
 */
export const recordCanSchema = (softDelete: boolean) =>
  z
    .object({
      update: z.boolean().describe('PATCH would be allowed.'),
      delete: z.boolean().describe('DELETE would be allowed.'),
      ...(softDelete && {
        restore: z
          .boolean()
          .describe(
            'It is in the recycle bin and POST …/{id}/restore would be allowed.',
          ),
      }),
    })
    .optional()
    .describe(
      'What you may do with it now, as its routes would decide. Only with `?include=can`; not part of the ETag.',
    );

/**
 * A record's API schemas, from its declaration: `create` (POST's body,
 * without read-only fields), `update` (PATCH's: only what is sent),
 * `response` (id, owner, unit, the fields (each left out when the reader
 * may not see it), dates, the recycle bin's, `can` with `?include=can`;
 * never the tenant). `response` takes what the
 * record's add-ons show (their exported response shape: `tags`), so the
 * documented response is the one the presenter answers. `body` takes
 * the keys add-ons read from the create and update bodies (their exported
 * body shape: `customFields`), each optional.
 *
 * ```ts
 * export const INVOICE_SCHEMAS = recordSchemas(INVOICE);
 * ```
 */
export function recordSchemas<
  const D extends RecordDeclaration,
  const X extends z.ZodRawShape = Record<never, never>,
  const B extends z.ZodRawShape = Record<never, never>,
>(declaration: D, { response: added, body }: { response?: X; body?: B } = {}) {
  const fields = fieldSchemas(declaration.fields);
  const noun = declaration.noun;
  const response = z.object({
    id: z.uuid(),
    ownerId: z
      .string()
      .describe('Who created it: `user:<id>` or `client:<id>`.'),
    ...(declaration.unit && {
      unitId: z
        .uuid()
        .nullable()
        .describe(
          "The creator's organizational unit, when they were in exactly one.",
        ),
    }),
    // A field the reader may not see (field-level permissions) is left out.
    ...(Object.fromEntries(
      Object.entries(fields.response).map(([name, schema]) => [
        name,
        (schema as z.ZodType).optional(),
      ]),
    ) as {
      [N in keyof typeof fields.response]: z.ZodOptional<
        (typeof fields.response)[N]
      >;
    }),
    ...(added as X),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    ...(declaration.softDelete && {
      deletedAt: z.iso
        .datetime()
        .nullable()
        .describe(
          `Set while the ${noun} is in the recycle bin (\`?deleted=true\`).`,
        ),
      deletedBy: z
        .string()
        .nullable()
        .describe('Who deleted it: `user:<id>` or `client:<id>`.'),
    }),
    can: recordCanSchema(declaration.softDelete),
  });
  if (!body) {
    return { create: fields.create, update: fields.update, response };
  }
  // What add-ons take in the bodies (`customFields`, `namingSeriesId`):
  // optional on create, and on update only what is sent.
  const extra = z.object(body).partial().shape;
  return {
    create: fields.create.extend(extra),
    update: fields.update.extend(extra),
    response,
  };
}

export type RecordSchemas = ReturnType<typeof recordSchemas>;
