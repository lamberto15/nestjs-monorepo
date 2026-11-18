import type { z } from 'zod';
import { recordSchemas } from '../../../src/modules/records/record.schemas.js';
import {
  CUSTOM_FIELDS_BODY,
  CUSTOM_FIELDS_RESPONSE,
} from '../../../src/modules/custom-fields/custom-fields.schemas.js';
import {
  NUMBER_BODY,
  NUMBER_RESPONSE,
} from '../../../src/modules/sequences/sequences.record.js';
import { TAGS_RESPONSE } from '../../../src/modules/tags/tags.schemas.js';
import { computedResponse } from '../../../src/modules/computed-fields/computed-fields.js';
import { GENERATED_ITEM_COMPUTED } from './generated-item.computed.js';
import { GENERATED_ITEM } from './generated-item.record.js';
import type { generatedItems } from './generated-items.tables.js';

/**
 * The API's schemas of generated items, from generated-item.record.ts,
 * with what its add-ons read from the bodies and show.
 */
export const GENERATED_ITEM_SCHEMAS = recordSchemas(GENERATED_ITEM, {
  body: { ...CUSTOM_FIELDS_BODY, ...NUMBER_BODY },
  response: {
    ...TAGS_RESPONSE,
    ...CUSTOM_FIELDS_RESPONSE,
    ...computedResponse(GENERATED_ITEM_COMPUTED),
    ...NUMBER_RESPONSE,
  },
});
export type CreateGeneratedItemDto = z.infer<
  typeof GENERATED_ITEM_SCHEMAS.create
>;
export type UpdateGeneratedItemDto = z.infer<
  typeof GENERATED_ITEM_SCHEMAS.update
>;

/** A generated item as stored; the API shows it through RecordPresenter. */
export type GeneratedItem = typeof generatedItems.$inferSelect;
