import { workflowPayloadCodec } from './workflow-payload.codec.js';

const OLD = 'a'.repeat(44);
const NEW = 'b'.repeat(44);
const context = { field: 'input', instanceId: 'wf-1' };

describe('workflowPayloadCodec', () => {
  it('is absent without keys', () => {
    expect(workflowPayloadCodec([])).toBeUndefined();
  });

  it('encrypts a payload and binds it to where it is stored', () => {
    const codec = workflowPayloadCodec([NEW])!;
    const stored = codec.encode({ secret: 'card 4242' }, context);

    expect(stored).not.toContain('4242');
    expect(codec.decode(stored, context)).toEqual({ secret: 'card 4242' });
    expect(() =>
      codec.decode(stored, { field: 'input', instanceId: 'wf-2' }),
    ).toThrow();
  });

  it('still reads what an older key wrote, and refuses once that key is gone', () => {
    const stored = workflowPayloadCodec([OLD])!.encode({ n: 1 }, context);

    expect(workflowPayloadCodec([NEW, OLD])!.decode(stored, context)).toEqual({
      n: 1,
    });
    expect(() =>
      workflowPayloadCodec([NEW])!.decode(stored, context),
    ).toThrow();
  });
});
