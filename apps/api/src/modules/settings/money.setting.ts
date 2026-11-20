import { z } from 'zod';
import { setting } from './settings.types.js';

/**
 * The currency a new amount starts in, for the tenant or one of its units
 * (a branch abroad): the web forms' money inputs begin with it, and the
 * person may type another. Money itself always carries its own currency;
 * this changes no stored amount.
 */
export const MONEY_CURRENCY = setting({
  key: 'money.currency',
  label: 'Currency',
  description:
    'The currency a new amount starts in (ISO 4217, three letters: EUR, USD, PHP).',
  schema: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Three capital letters (ISO 4217): EUR, USD, PHP.'),
  default: 'EUR',
  scopes: ['tenant', 'unit'],
});
