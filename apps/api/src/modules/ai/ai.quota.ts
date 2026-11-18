import { defineQuota } from '../quotas/quota.js';

/**
 * The tokens (input plus output) a tenant's runs may spend in a UTC day.
 * Checked when a run is asked for, counted when it ends: a run already
 * queued may overshoot the limit by its own cost. Operators change it per
 * tenant or plan (modules/quotas); 500 000 until they do.
 */
export const AI_TOKENS = defineQuota({
  key: 'ai.tokensPerDay',
  label: 'AI tokens a day',
  kind: 'rate',
  period: 'day',
  default: 500_000,
});
