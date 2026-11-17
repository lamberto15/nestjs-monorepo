import { definePermissions } from '../access/permissions.js';

/**
 * What the API clients module adds to the catalog: the `Access` action that
 * guards creating, changing, rotating and deleting clients (reading them is
 * AccessPolicy.open, which counts it).
 */
export const API_CLIENT_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageClients: [] } },
  },
});
