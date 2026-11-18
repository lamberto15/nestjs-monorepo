import { z } from 'zod';

/** The bundle's format version: a newer one is refused, never half-read. */
export const CONFIG_BUNDLE_VERSION = 1;

/**
 * A configuration bundle: what a tenant's modules carry, one section each
 * (`contents.settings`, `contents.roles`…), by stable reference (setting
 * keys, role names), with a SHA-256 checksum of `contents`. No secrets, no
 * credentials, no business records. Each section is checked by the module
 * that owns it.
 */
export const configBundleSchema = z.object({
  format: z.literal('config-bundle'),
  version: z.number().int().min(1),
  exportedAt: z.iso.datetime({ offset: true }),
  /** `sha256:<hex>` of the canonical JSON of `contents` (keys sorted). */
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  contents: z.record(z.string().max(100), z.unknown()),
});
export type ConfigBundle = z.infer<typeof configBundleSchema>;

export const previewBodySchema = z.object({ bundle: configBundleSchema });

export const applyBodySchema = z.object({
  bundle: configBundleSchema,
  /** The preview's `targetVersion`: 409 config_changed when the target changed since. */
  targetVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

const issueSchema = z.object({
  section: z.string().nullable().describe('Null: the bundle itself.'),
  /** The item's key or name; null for the bundle or the section. */
  ref: z.string().nullable(),
  message: z.string(),
});

export const previewSchema = z.object({
  /** No errors: apply may run. */
  valid: z.boolean(),
  errors: z.array(issueSchema),
  /** Applied as they are, but worth a look (an id of this environment's records in a condition). */
  warnings: z.array(issueSchema),
  changes: z.array(
    z.object({
      section: z.string(),
      ref: z.string(),
      action: z.enum(['create', 'update', 'unchanged']),
    }),
  ),
  /** What the target holds now, for what the bundle touches: hand it to apply. */
  targetVersion: z.string(),
});
export type ConfigPreview = z.infer<typeof previewSchema>;

export const appliedSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});
