const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A key of a tenant's file: every tenant's files are under
 * `tenants/<tenant id>/`, from the first file on, so a tenant's export or
 * deletion is a prefix operation and a key built for one tenant never lands
 * among another's. The tenant comes from the principal or the context of the
 * work, never from the client; this module does not know where it comes from.
 */
export function tenantFileKey(tenantId: string, path: string) {
  if (!UUID.test(tenantId)) {
    throw new TypeError(`Not a tenant id: ${JSON.stringify(tenantId)}`);
  }
  return `tenants/${tenantId}/${path.replace(/^\/+/, '')}`;
}

/** Where an account's own files live (`accounts/<user id>/…`): a person's data export, which spans their tenants. */
export function accountFileKey(userId: string, path: string) {
  if (!UUID.test(userId)) {
    throw new TypeError(`Not a user id: ${JSON.stringify(userId)}`);
  }
  return `accounts/${userId}/${path.replace(/^\/+/, '')}`;
}

/** Whether `key` is one of this tenant's files (a key read back from a job's payload). */
export const isTenantFileKey = (tenantId: string, key: string) =>
  key.startsWith(`tenants/${tenantId}/`) && !key.includes('..');
