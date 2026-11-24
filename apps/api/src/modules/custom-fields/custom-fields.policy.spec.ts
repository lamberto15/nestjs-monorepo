import type { AccessService } from '../../iam/access/access.service.js';
import {
  type ClientPrincipal,
  type Principal,
  systemPrincipal,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { CustomFieldPolicy } from './custom-fields.policy.js';

const user: UserPrincipal = {
  kind: 'user',
  id: 'u1',
  email: 'member@example.com',
  name: 'Member',
  emailVerified: true,
  locale: null,
  timezone: null,
  tenantId: 't1',
};
const impersonated: UserPrincipal = {
  ...user,
  impersonator: { id: 'a1', email: 'admin@example.com' },
};
const client: ClientPrincipal = {
  kind: 'client',
  id: 'c1',
  name: 'Client',
  tenantId: 't1',
};
const system = systemPrincipal({ key: 'job', label: 'Job' });

/** The policy over an access service in which the principal holds `held` (`Subject.action`). */
function policyHolding(...held: string[]) {
  const can = vi.fn(
    async (_: Principal | null, action: string, subject: string) =>
      held.includes(`${subject}.${action}`),
  );
  return {
    policy: new CustomFieldPolicy({ can } as unknown as AccessService),
    can,
  };
}

describe('CustomFieldPolicy', () => {
  describe('manageCustomFields', () => {
    it('allows a user holding Access.manageCustomFields, asked for it', async () => {
      const { policy, can } = policyHolding('Access.manageCustomFields');
      expect(await policy.manageCustomFields(user)).toBe(true);
      expect(can).toHaveBeenCalledWith(user, 'manageCustomFields', 'Access');
    });

    it('refuses a user without it', async () => {
      expect(await policyHolding().policy.manageCustomFields(user)).toBe(false);
    });

    it.each([
      ['a guest', null],
      ['an API client', client],
      ['the system', system],
      ['an impersonated user', impersonated],
    ] as const)('refuses %s, whatever its permissions', async (_, p) => {
      const { policy } = policyHolding('Access.manageCustomFields');
      expect(await policy.manageCustomFields(p)).toBe(false);
    });
  });

  describe('read', () => {
    it.each([
      ['a user', user],
      ['an API client', client],
    ] as const)('allows %s who may read the subject', async (_, p) => {
      const { policy, can } = policyHolding('Invoice.read');
      expect(await policy.read(p, 'Invoice')).toBe(true);
      expect(can).toHaveBeenCalledWith(p, 'read', 'Invoice');
    });

    it('allows a user who manages custom fields without reading the subject', async () => {
      const { policy } = policyHolding('Access.manageCustomFields');
      expect(await policy.read(user, 'Invoice')).toBe(true);
    });

    it('refuses who may read another subject only', async () => {
      const { policy } = policyHolding('Customer.read');
      expect(await policy.read(user, 'Invoice')).toBe(false);
    });

    it('refuses an API client holding manageCustomFields but not the read', async () => {
      const { policy } = policyHolding('Access.manageCustomFields');
      expect(await policy.read(client, 'Invoice')).toBe(false);
    });
  });
});
