import { definePermissions } from '../../iam/access/permissions.js';

/**
 * Who may see and change settings (settings.policy.ts): `read` shows the
 * settings that are not public and every stored value; `update` sets and
 * removes the values of a tenant, a unit or a principal, and (in the
 * operators' tenant) the platform values. Everyone reads their own values
 * and sets their own preferences with no permission.
 */
export const SETTING_PERMISSIONS = definePermissions({
  subjects: {
    Setting: { actions: { read: [], update: [] } },
  },
});
