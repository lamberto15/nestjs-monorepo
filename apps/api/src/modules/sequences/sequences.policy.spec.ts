import type { AccessService } from '../../iam/access/access.service.js';
import {
  type ClientPrincipal,
  systemPrincipal,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { NamingSeriesPolicy } from './sequences.policy.js';

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

/** The policy over an access service that answers every question with `allowed`. */
function policyAnswering(allowed: boolean) {
  const can = vi.fn(async () => allowed);
  return {
    policy: new NamingSeriesPolicy({ can } as unknown as AccessService),
    can,
  };
}

describe('NamingSeriesPolicy', () => {
  describe.each([
    ['manageNamingSeries', 'manageNamingSeries', 'Access'],
  ] as const)(
    '%s: a user holding %s on %s, never while impersonating',
    (ability, action, subject) => {
      it('allows a user holding the permission, asked for it', async () => {
        const { policy, can } = policyAnswering(true);
        expect(await policy[ability](user)).toBe(true);
        expect(can).toHaveBeenCalledWith(user, action, subject);
      });

      it('refuses a user without the permission', async () => {
        expect(await policyAnswering(false).policy[ability](user)).toBe(false);
      });

      it.each([
        ['a guest', null],
        ['an API client', client],
        ['the system', system],
        ['an impersonated user', impersonated],
      ] as const)(
        'refuses %s, whatever its permissions',
        async (_, principal) => {
          expect(await policyAnswering(true).policy[ability](principal)).toBe(
            false,
          );
        },
      );
    },
  );
});
