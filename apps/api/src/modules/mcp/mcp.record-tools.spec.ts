import { z } from 'zod';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { recordSchemas } from '../records/record.schemas.js';
import { createKeyRule, writeInputs } from './mcp.record-tools.js';

describe('the record tools: idempotency key of _create', () => {
  it('follows the record, else the deployment, as POST does', () => {
    expect(createKeyRule(TEST_ITEM, 'required')).toBe('required');
    expect(createKeyRule(TEST_ITEM, 'optional')).toBe('optional');
    expect(
      createKeyRule({ ...TEST_ITEM, idempotency: 'off' }, 'required'),
    ).toBe('off');
    expect(
      createKeyRule({ ...TEST_ITEM, idempotency: 'required' }, 'optional'),
    ).toBe('required');
  });

  it('requires the key when the rule does, and leaves it out when off', () => {
    const schemas = recordSchemas(TEST_ITEM);
    const create = (rule: 'required' | 'optional' | 'off') =>
      writeInputs(schemas, rule, z.uuid()).create;
    expect(create('required').safeParse({ title: 'A' }).success).toBe(false);
    expect(
      create('required').safeParse({ title: 'A', idempotencyKey: 'k-1' })
        .success,
    ).toBe(true);
    expect(create('optional').safeParse({ title: 'A' }).success).toBe(true);
    expect(create('off').shape).not.toHaveProperty('idempotencyKey');
  });
});
