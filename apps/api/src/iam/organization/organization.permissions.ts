import { definePermissions } from '../access/permissions.js';

/**
 * What the organization module adds to the catalog: the `Access` action
 * that guards the unit tree. Placing people in units is `Access.manageUsers`
 * (with authority over the unit, OrganizationService).
 */
export const ORGANIZATION_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageOrganizationalUnits: [] } },
  },
});
