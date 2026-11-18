import { z } from 'zod';

export const encryptionStatusSchema = z
  .object({
    enabled: z
      .boolean()
      .describe('False while DATA_ENCRYPTION_KEYS is not set.'),
    dataKeyId: z
      .string()
      .nullable()
      .describe('The key new values are encrypted with.'),
    indexKeyId: z
      .string()
      .nullable()
      .describe('The key new blind indexes are made with.'),
    upToDate: z
      .boolean()
      .describe(
        'No row is on an old key: the old keys may leave the environment.',
      ),
    columns: z.array(
      z.object({
        column: z.string().meta({ example: 'webhook_senders.secret' }),
        blindIndex: z.boolean(),
        staleRows: z
          .int()
          .describe(
            'Rows, in every tenant, whose value or index is not under the current key.',
          ),
      }),
    ),
  })
  .meta({ id: 'EncryptionStatus' });

export const reencryptionQueuedSchema = z
  .object({
    queued: z
      .int()
      .describe(
        'Jobs queued: one per tenant (or the tenantless tables) with stale rows.',
      ),
  })
  .meta({ id: 'ReencryptionQueued' });
