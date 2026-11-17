import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../../core/config/env.js';
import { APP_MODES } from './mode.setting.js';

export const schema = z.object({
  /**
   * Forces the deployment's mode: `normal`, `read-only` or `maintenance`.
   * It wins over the operators' `platform.mode` setting, which then refuses
   * a new value. For when the API cannot be reached to set it. Unset: the setting.
   */
  APP_MODE: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(APP_MODES).optional(),
  ),
});

export const modeConfig = registerAs('mode', () => {
  const env = readEnv(schema);
  return { forced: env.APP_MODE };
});

export type ModeSettings = ReturnType<typeof modeConfig>;
