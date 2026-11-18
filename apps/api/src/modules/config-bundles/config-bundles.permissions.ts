import { definePermissions } from '../../iam/access/permissions.js';

/**
 * Exporting a bundle reads the tenant's whole configuration; applying one
 * writes it, section by section, through each module's own services. Hold
 * `apply` only with the permissions of every section (administrators do).
 */
export const CONFIG_BUNDLE_PERMISSIONS = definePermissions({
  subjects: {
    ConfigBundle: { actions: { export: [], apply: [] } },
  },
});
