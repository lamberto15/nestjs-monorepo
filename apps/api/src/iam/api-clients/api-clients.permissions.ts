import { definePermissions } from '../access/permissions.js';
import { apiKeys } from '../auth/auth.tables.js';

/**
 * What the API clients module adds to the catalog: the `Access` action that
 * guards creating, changing, rotating and deleting clients (reading them is
 * AccessPolicy.open, which counts it), and `ApiKey.read` of a client's own
 * keys, which every client holds: what lets the rotation webhook
 * (`security.api-key-rotated`) reach the rotated client only.
 */
export const API_CLIENT_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageClients: [] } },
    ApiKey: {
      actions: { read: ['own'] },
      conditions: {
        // A key of the client asking; for a user, nothing.
        own: {
          where: (principal) => [
            [
              apiKeys.clientId,
              principal.kind === 'client' ? principal.id : undefined,
            ],
          ],
        },
      },
    },
  },
  clientPermissions: [
    { subject: 'ApiKey', action: 'read', conditions: [{ key: 'own' }] },
  ],
});
