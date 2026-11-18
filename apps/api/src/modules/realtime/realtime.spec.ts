import { z } from 'zod';
import { systemPrincipal } from '../../iam/auth/principal.js';
import {
  addRealtimeEvents,
  defineRealtimeEvent,
  payloadProblem,
} from './realtime.events.js';
import { openApiAdditions } from '../../core/http/openapi.js';
import { principalRoom } from './realtime.rooms.js';

describe('realtime events', () => {
  const ready = defineRealtimeEvent(
    'thumbnail.ready',
    z.object({ fileKey: z.string() }),
  );

  it('refuses a name that is not lowercase and full-stop delimited', () => {
    expect(() => defineRealtimeEvent('Thumbnail Ready', z.object({}))).toThrow(
      /not a realtime event name/,
    );
  });

  it('names the event and the field when a payload is off its schema', () => {
    expect(payloadProblem(ready, { fileKey: 'a' })).toBeUndefined();
    expect(payloadProblem(ready, { fileKey: 1 })).toMatch(
      /thumbnail\.ready.*fileKey/s,
    );
  });
});

describe('the realtime manifest', () => {
  defineRealtimeEvent(
    'manifest.checked',
    z.object({ id: z.uuid(), count: z.int().optional() }),
    'Checked by the manifest spec.',
  );

  it('publishes every defined event, with its payload component, as x-realtime-events', () => {
    const document: Record<string, any> = { components: { schemas: {} } };
    addRealtimeEvents(document as never);
    expect(document['x-realtime-events']['manifest.checked']).toEqual({
      description: 'Checked by the manifest spec.',
      payload: { $ref: '#/components/schemas/RealtimeManifestCheckedEvent' },
    });
    expect(
      document.components.schemas.RealtimeManifestCheckedEvent,
    ).toMatchObject({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, count: { type: 'integer' } },
    });
  });

  it('is part of the OpenAPI document the app builds', () => {
    expect(openApiAdditions.document.get('realtime')).toBe(addRealtimeEvents);
  });
});

describe('principalRoom', () => {
  it("is the principal's in a tenant, or the account's outside one", () => {
    expect(principalRoom({ kind: 'user', id: 'u1' }, 't1')).toBe(
      'tenant:t1:principal:user:u1',
    );
    expect(principalRoom({ kind: 'user', id: 'u1' }, null)).toBe(
      'principal:user:u1',
    );
  });

  it('refuses the system principal: it never connects', () => {
    expect(() =>
      principalRoom(systemPrincipal({ key: 'job', label: 'Job' }), 't1'),
    ).toThrow(/system principal/);
  });
});
