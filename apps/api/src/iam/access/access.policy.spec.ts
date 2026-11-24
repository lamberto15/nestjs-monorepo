import {
  type ClientPrincipal,
  type Principal,
  systemPrincipal,
  type UserPrincipal,
} from '../auth/principal.js';
import { AccessPolicy } from './access.policy.js';
import type { AccessService } from './access.service.js';

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

/** The policy over an access service in which the principal holds `held` on `Access`. */
function policyHolding(...held: string[]) {
  const can = vi.fn(
    async (_: Principal | null, action: string, subject: string) =>
      subject === 'Access' && held.includes(action),
  );
  return {
    policy: new AccessPolicy({ can } as unknown as AccessService),
    can,
  };
}

const everything = [
  'manageRoles',
  'manageUsers',
  'manageOrganizationalUnits',
  'manageClients',
  'impersonate',
  'readAudit',
  'manageSso',
];
const outsiders = [
  ['a guest', null],
  ['an API client', client],
  ['the system', system],
  ['an impersonated user', impersonated],
] as const;

describe('AccessPolicy', () => {
  describe.each(['manageRoles', 'manageUsers'] as const)('%s', (ability) => {
    it('allows a user holding Access.%s, asked for it', async () => {
      const { policy, can } = policyHolding(ability);
      expect(await policy[ability](user)).toBe(true);
      expect(can).toHaveBeenCalledWith(user, ability, 'Access');
    });

    it('refuses a user holding the other management permission only', async () => {
      const other = ability === 'manageRoles' ? 'manageUsers' : 'manageRoles';
      expect(await policyHolding(other).policy[ability](user)).toBe(false);
    });

    it.each(outsiders)('refuses %s, whatever its permissions', async (_, p) => {
      expect(await policyHolding(...everything).policy[ability](p)).toBe(false);
    });
  });

  describe('explain', () => {
    it.each(['manageRoles', 'manageUsers'])(
      'allows a user holding %s',
      async (action) => {
        expect(await policyHolding(action).policy.explain(user)).toBe(true);
      },
    );

    it('refuses a user holding neither', async () => {
      const { policy } = policyHolding('readAudit', 'impersonate');
      expect(await policy.explain(user)).toBe(false);
    });

    it.each(outsiders)('refuses %s, whatever its permissions', async (_, p) => {
      expect(await policyHolding(...everything).policy.explain(p)).toBe(false);
    });
  });

  describe('open', () => {
    it.each([
      'manageRoles',
      'manageUsers',
      'manageOrganizationalUnits',
      'manageClients',
      'impersonate',
      'readAudit',
    ])('allows a user holding only %s', async (action) => {
      expect(await policyHolding(action).policy.open(user)).toBe(true);
    });

    it('refuses a user holding no access administration permission', async () => {
      expect(await policyHolding().policy.open(user)).toBe(false);
    });

    it('refuses a user holding manageSso only: that opens the SSO pickers alone', async () => {
      expect(await policyHolding('manageSso').policy.open(user)).toBe(false);
    });

    it.each(outsiders)('refuses %s, whatever its permissions', async (_, p) => {
      expect(await policyHolding(...everything).policy.open(p)).toBe(false);
    });
  });

  describe('openForSso', () => {
    it('allows a user holding manageSso only', async () => {
      const { policy, can } = policyHolding('manageSso');
      expect(await policy.openForSso(user)).toBe(true);
      expect(can).toHaveBeenCalledWith(user, 'manageSso', 'Access');
    });

    it('allows whoever may open the access API', async () => {
      expect(await policyHolding('readAudit').policy.openForSso(user)).toBe(
        true,
      );
    });

    it('refuses a user holding none of them', async () => {
      expect(await policyHolding().policy.openForSso(user)).toBe(false);
    });

    it.each(outsiders)('refuses %s, whatever its permissions', async (_, p) => {
      expect(await policyHolding(...everything).policy.openForSso(p)).toBe(
        false,
      );
    });
  });
});
