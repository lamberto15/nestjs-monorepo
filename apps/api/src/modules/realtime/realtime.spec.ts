import { z } from 'zod';
import { systemPrincipal } from '../../iam/auth/principal.js';
import { defineRealtimeEvent, payloadProblem } from './realtime.events.js';
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
