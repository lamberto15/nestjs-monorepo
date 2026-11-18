import { z } from 'zod';
import { defineSettings, setting } from '../settings/settings.types.js';

/**
 * A tenant's opt-in, and the operators' kill switch: the helper sends a
 * record's fields to an outside provider, so it is off until an
 * administrator turns it on for the tenant; an operators' enforced platform
 * value (PUT /v1/settings/ai.enabled/platform) switches it off for every
 * tenant at once.
 */
export const AI_ENABLED = setting({
  key: 'ai.enabled',
  label: 'AI helper',
  description:
    'Let people ask the AI helper to summarize records. Their fields (only those the person may read) are sent to the provider (Anthropic) for each request. Off until you turn it on.',
  schema: z.boolean(),
  default: false,
  // Everyone signed in may read it, so the web app can hide the helper.
  public: true,
});

export const AI_SETTINGS = defineSettings([AI_ENABLED]);
