import { definePermissions } from '../../iam/access/permissions.js';

/**
 * Who manages webhooks for others: an API client's outgoing endpoints on
 * its behalf (`/v1/access/clients/{clientId}/webhook-…`), and the tenant's
 * incoming senders. A client manages its own endpoints with its key, with
 * no permission. Administrators hold both.
 */
export const WEBHOOK_PERMISSIONS = definePermissions({
  subjects: {
    Webhooks: { actions: { manageEndpoints: [], manageSenders: [] } },
  },
});
