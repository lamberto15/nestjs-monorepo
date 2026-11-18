import { definePermissions } from '../../iam/access/permissions.js';

/**
 * Who sees the data-quality findings and who acts on them. Reading is on top
 * of the subject's own read permission (only findings on records and fields
 * the caller may read); no seed role holds either: administrators give them
 * in a role.
 */
export const DATA_QUALITY_PERMISSIONS = definePermissions({
  subjects: {
    DataQuality: { actions: { read: [], scan: [], resolve: [] } },
  },
});
