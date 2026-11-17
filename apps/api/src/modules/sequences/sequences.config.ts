import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { withDefault } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /** IANA time zone whose calendar decides a number's year, month and day (`YYYY`, `MM`…): a series restarts at that zone's new year. */
  SEQUENCES_TIMEZONE: withDefault('UTC').refine(
    (zone) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'an IANA time zone, such as Europe/Berlin' },
  ),
});

export const sequencesConfig = registerAs('sequences', () => ({
  timezone: readEnv(schema).SEQUENCES_TIMEZONE,
}));
