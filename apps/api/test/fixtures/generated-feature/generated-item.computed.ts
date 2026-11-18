import {
  computed,
  defineComputed,
} from '../../../src/modules/computed-fields/computed-fields.js';
import { GENERATED_ITEM } from './generated-item.record.js';

/**
 * Values derived from a generated item's fields on every read, never stored.
 * Business logic: the computed fields (expressions of modules/expressions).
 */
export const GENERATED_ITEM_COMPUTED = defineComputed(GENERATED_ITEM, {
  titleLength: computed.int('length(title)'),
});
