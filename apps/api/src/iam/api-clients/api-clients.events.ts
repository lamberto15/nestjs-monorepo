import { defineEvent } from '../../core/outbox/events.js';

/**
 * A client's keys were rotated: a domain event (core/outbox), published in
 * the rotation's transaction, in the client's tenant, for the client itself
 * (modules/webhooks sends it to that client's endpoints as a webhook).
 */
export const apiKeyRotated = defineEvent<{
  clientId: string;
  /** The new key's public id (the middle of `sk_<id>_<secret>`). */
  keyId: string;
  /** When the client's previous keys stop working (ISO 8601). */
  previousKeysEnd: string;
}>('security.api-key-rotated');

/**
 * What API clients tell the rest of the app (@nestjs/event-emitter,
 * `emitAsync()` after the change committed). The names are the contract with
 * modules/realtime, which ends the sockets they name.
 */
export const API_CLIENT_EVENTS = {
  /** A client was deleted or deactivated: its connections end. */
  revoked: 'access.client-revoked',
  /** Keys were revoked (one, or a rotation's without a grace period): the sockets they opened end. */
  keysRevoked: 'access.keys-revoked',
} as const;

export interface ClientRevokedEvent {
  clientId: string;
  tenantId: string;
}

export interface KeysRevokedEvent {
  /** The keys' public ids (the middle of `sk_<id>_<secret>`). */
  keyIds: string[];
}
