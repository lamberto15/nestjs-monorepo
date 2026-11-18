import { recordPermissions } from '../../../src/modules/records/record.permissions.js';
import { GENERATED_ITEM } from './generated-item.record.js';
import { generatedItems } from './generated-items.tables.js';

/**
 * What can be done with generated items: the standard actions, conditions and
 * seed roles' grants from generated-item.record.ts. Business logic: fields
 * granted one by one (`fields`), conditions and actions of its own.
 */
export const GENERATED_ITEM_PERMISSIONS = recordPermissions(
  GENERATED_ITEM,
  generatedItems,
);
