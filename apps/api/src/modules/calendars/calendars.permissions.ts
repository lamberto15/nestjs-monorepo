import { definePermissions } from '../../iam/access/permissions.js';

/** What the calendars module adds to the catalog: the `Access` action that guards writing a calendar. */
export const CALENDAR_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageCalendars: [] } },
  },
});
