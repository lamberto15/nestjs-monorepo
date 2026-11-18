import { opsEvent } from './ops.events.js';

describe('opsEvent', () => {
  it('tags the source, reduces an error to a masked message and keeps no stack', () => {
    const event = opsEvent(
      'mail',
      {
        type: 'failed',
        messageId: 'm1',
        recipients: ['a@example.com'],
        subject: 'Hello',
        transport: 'smtp',
        attempts: 2,
        durationMs: 12.5,
        permanent: false,
        error: new Error('refused: password=hunter2'),
      },
      1000,
    );
    expect(event).toMatchObject({ source: 'mail', at: 1000, type: 'failed' });
    expect(JSON.stringify(event)).not.toContain('hunter2');
    expect(JSON.stringify(event)).not.toContain('at Object');
  });

  it('never carries a payload or a header, whatever the engine sent', () => {
    const event = opsEvent('outbox', {
      type: 'published',
      transport: 'bullmq',
      durationMs: 3,
      message: {
        id: 'o1',
        topic: 'x',
        key: null,
        createdAt: 1,
        availableAt: 1,
        attempts: 0,
        lastError: null,
        headers: { authorization: 'Bearer abc' },
        payload: { email: 'person@example.com' },
      },
    });
    expect(event).toBeDefined();
    expect(JSON.stringify(event)).not.toContain('person@example.com');
    expect(JSON.stringify(event)).not.toContain('Bearer');
  });

  it('leaves out an event the schema does not know, instead of failing', () => {
    expect(opsEvent('workflow', { type: 'something-new' })).toBeUndefined();
  });

  it("keeps the resilience policy's own source as origin", () => {
    expect(
      opsEvent('resilience', {
        type: 'timeout',
        policy: 'p',
        source: 'http',
        timeoutMs: 5,
      }),
    ).toMatchObject({ source: 'resilience', origin: 'http' });
  });
});
