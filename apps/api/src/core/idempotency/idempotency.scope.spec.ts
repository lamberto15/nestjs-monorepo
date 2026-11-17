import { callerScope } from './idempotency.scope.js';

describe('callerScope', () => {
  it('namespaces a caller by kind, id and tenant', () => {
    expect(
      callerScope({ user: { kind: 'user', id: 'u1', tenantId: 't1' } }),
    ).toBe('tenant:t1:user:u1');
    expect(
      callerScope({ user: { kind: 'client', id: 'c1', tenantId: null } }),
    ).toBe('account:client:c1');
  });

  it('shares one namespace between guests, and refuses the system', () => {
    expect(callerScope({})).toBeUndefined();
    expect(() =>
      callerScope({ user: { kind: 'system', id: 'job' } }),
    ).toThrow();
  });
});
