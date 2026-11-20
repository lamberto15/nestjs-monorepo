import { z } from 'zod';
import { setting } from './settings.types.js';

/**
 * The web dashboard's layout: each person's own (a preference the dashboard
 * page reads and writes, not one the settings page lists).
 */
export const DASHBOARD_LAYOUT = setting({
  key: 'dashboard.layout',
  label: 'Dashboard layout',
  description: 'Which dashboard cards you hide and the order you prefer.',
  schema: z
    .object({
      hidden: z.array(z.string().min(1).max(100)).max(100),
      order: z.array(z.string().min(1).max(100)).max(100),
    })
    .strict(),
  default: { hidden: [], order: [] },
  scopes: ['user'],
});
