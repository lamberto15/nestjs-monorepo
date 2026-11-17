/** What the scope reads of `request.user`: a user or an API client (the principal of iam/auth), by shape, so core imports nothing from iam. */
interface Caller {
  kind: string;
  id: string;
  tenantId?: string | null;
}

/**
 * The key namespace: whoever is calling, a client (by its key) or a user (by
 * their session), in the tenant they act in. Guards run before the
 * interceptor, so `request.user` is set; two callers sending the same key
 * never replay each other's responses, and neither does one person in two
 * tenants (`tenant:<id>:user:<id>`). A user acting in no tenant has an
 * account scope of their own. No caller (a guest): the shared namespace.
 */
export const callerScope = (request: { user?: Caller | null }) => {
  const caller = request.user;
  if (!caller) {
    return undefined;
  }
  // The system principal is never a request's: a bug, not a caller.
  if (caller.kind === 'system') {
    throw new Error('An idempotency scope takes a user or a client.');
  }
  const key = `${caller.kind}:${caller.id}`;
  return caller.tenantId
    ? `tenant:${caller.tenantId}:${key}`
    : `account:${key}`;
};
