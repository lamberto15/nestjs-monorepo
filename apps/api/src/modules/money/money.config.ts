import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { baseUrl, flag } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /** Fetch the ECB's euro reference rates every working day (modules/money): off for an app without money, and in tests. */
  EXCHANGE_RATES_FETCH: flag('on'),
  /** Where the ECB's eurofxref documents are (eurofxref-daily.xml, eurofxref-hist-90d.xml): a mirror, or a stub in tests. */
  EXCHANGE_RATES_ECB_URL: baseUrl('https://www.ecb.europa.eu/stats/eurofxref'),
});

export const moneyConfig = registerAs('money', () => {
  const env = readEnv(schema);
  return {
    fetchRates: env.EXCHANGE_RATES_FETCH,
    ecbUrl: env.EXCHANGE_RATES_ECB_URL!,
  };
});
