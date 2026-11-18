import { sum } from 'drizzle-orm';
import { defineQuota } from '../quotas/quota.js';
import { attachments, attachmentVersions } from './attachments.tables.js';

/**
 * The bytes of files a tenant keeps: attachments and their earlier versions
 * (the renditions are not counted: they are derived; an upload that is
 * announced and not completed is not either).
 */
export const STORAGE_BYTES = defineQuota({
  key: 'storageBytes',
  label: 'bytes of files',
  kind: 'stock',
  count: async (db) => {
    const [current] = await db
      .select({ bytes: sum(attachments.size) })
      .from(attachments);
    const [earlier] = await db
      .select({ bytes: sum(attachmentVersions.size) })
      .from(attachmentVersions);
    return Number(current?.bytes ?? 0) + Number(earlier?.bytes ?? 0);
  },
});
