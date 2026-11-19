import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ACCESS_EVENTS,
  type MemberDeactivatedEvent,
} from '../../iam/access/access.events.js';
import {
  AUTH_EVENTS,
  type SessionEndedEvent,
  type TokenSessionEndedEvent,
} from '../../iam/auth/auth.events.js';
import { Realtime } from './realtime.service.js';
import {
  keyRoom,
  principalRoom,
  sessionRoom,
  tenantRoom,
  tokenRoom,
} from './realtime.rooms.js';

/**
 * Events of the owning modules (@nestjs/event-emitter, emitted after the
 * change committed) that end sockets: a socket is authenticated at its
 * handshake only, so what it was let in by ending must close it. The names
 * and payloads below are the contract with the emitters; the first two are
 * auth's (auth.events.ts), the third access's (access.events.ts).
 */
export const REALTIME_DISCONNECT_EVENTS = {
  /** An API client was deleted or deactivated: its connections end. */
  clientRevoked: 'access.client-revoked',
  /** API keys were revoked (one, or a rotation's without a grace period): the sockets they opened end; the client's others stay. */
  keysRevoked: 'access.keys-revoked',
  /** A tenant was deactivated: every connection in it ends. */
  tenantDeactivated: 'tenancy.tenant-deactivated',
} as const;

export interface ClientRevokedEvent {
  clientId: string;
  tenantId: string;
}
export interface KeysRevokedEvent {
  /** The keys' public ids (`sk_<id>_…`). */
  keyIds: string[];
}
export interface TenantDeactivatedEvent {
  tenantId: string;
}

const EVENTS = REALTIME_DISCONNECT_EVENTS;

@Injectable()
export class RealtimeDisconnects {
  constructor(private readonly realtime: Realtime) {}

  @OnEvent(AUTH_EVENTS.sessionEnded)
  sessionEnded({ sessionId }: SessionEndedEvent) {
    this.realtime.disconnect([sessionRoom(sessionId)]);
  }

  /** A token client's family: sign-out, a reused refresh token, signing out everywhere. */
  @OnEvent(AUTH_EVENTS.tokenSessionEnded)
  tokenSessionEnded({ sid }: TokenSessionEndedEvent) {
    this.realtime.disconnect([tokenRoom(sid)]);
  }

  /** A membership was deactivated: that user's connections in that tenant end. */
  @OnEvent(ACCESS_EVENTS.memberDeactivated)
  memberDeactivated({ userId, tenantId }: MemberDeactivatedEvent) {
    this.realtime.disconnect([
      principalRoom({ kind: 'user', id: userId }, tenantId),
    ]);
  }

  @OnEvent(EVENTS.clientRevoked)
  clientRevoked({ clientId, tenantId }: ClientRevokedEvent) {
    this.realtime.disconnect([
      principalRoom({ kind: 'client', id: clientId }, tenantId),
    ]);
  }

  @OnEvent(EVENTS.keysRevoked)
  keysRevoked({ keyIds }: KeysRevokedEvent) {
    this.realtime.disconnect(keyIds.map(keyRoom));
  }

  @OnEvent(EVENTS.tenantDeactivated)
  tenantDeactivated({ tenantId }: TenantDeactivatedEvent) {
    this.realtime.disconnect([tenantRoom(tenantId)]);
  }
}
