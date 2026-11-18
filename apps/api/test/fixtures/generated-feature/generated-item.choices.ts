import { Injectable } from '@nestjs/common';
import {
  type ChoiceProvider,
  type ChoiceSet,
  ChoiceSource,
} from '../../../src/modules/choices/choices.registry.js';

/** The values of `status` (generated-item.record.ts). */
const VALUES: readonly string[] = ['draft', 'done'];

/**
 * The status a writer may pick: every value of the field.
 * Business logic: narrow them by `principal` or by a parent field (`params`).
 */
@ChoiceSource()
@Injectable()
export class GeneratedItemChoices implements ChoiceProvider {
  readonly key = 'generated-item-status';
  readonly label = 'Generated item status';
  readonly params = {};
  mayUse = () => Promise.resolve(true);
  options = () =>
    Promise.resolve(VALUES.map((value) => ({ value, label: value })));
  has = ({ value }: { value: string }) =>
    Promise.resolve(VALUES.includes(value));
}

/** The fields chosen together: `ChoicesModule.forRecord(GENERATED_ITEM, GENERATED_ITEM_CHOICES)`. */
export const GENERATED_ITEM_CHOICES: ChoiceSet = {
  key: 'generated-item-status',
  label: 'Status',
  fields: { status: { provider: 'generated-item-status' } },
};
