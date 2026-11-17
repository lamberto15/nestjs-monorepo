import { definePermissions } from '../access/permissions.js';

/**
 * Break-glass: an operator reads, in an emergency, a tenant that never
 * invited them. Held in the operators' tenant (`@OperatorOnly()` on top).
 */
export const BREAK_GLASS_PERMISSIONS = definePermissions({
  subjects: { Platform: { actions: { breakGlass: [] } } },
});
