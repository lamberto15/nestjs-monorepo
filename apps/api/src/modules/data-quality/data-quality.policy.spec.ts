import type { AccessService } from '../../iam/access/access.service.js';
import type {
  ClientPrincipal,
  UserPrincipal,
} from '../../iam/auth/principal.js';
import { DataQualityPolicy } from './data-quality.policy.js';

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
const client: ClientPrincipal = {
  kind: 'client',
  id: 'c1',
  name: 'Client',
  tenantId: 't1',
};

/** The policy over an access service that answers every question with `allowed`. */
function policyAnswering(allowed: boolean) {
  const can = vi.fn(async () => allowed);
  return {
    policy: new DataQualityPolicy({ can } as unknown as AccessService),
    can,
  };
}

describe('DataQualityPolicy', () => {
  describe.each([
    ['read', 'read', 'DataQuality'],
    ['scan', 'scan', 'DataQuality'],
    ['resolve', 'resolve', 'DataQuality'],
  ] as const)(
    '%s: whoever holds %s on %s, user or API client',
    (ability, action, subject) => {
      it.each([
        ['a user', user],
        ['an API client', client],
      ] as const)(
        'allows %s holding the permission, asked for it',
        async (_, principal) => {
          const { policy, can } = policyAnswering(true);
          expect(await policy[ability](principal)).toBe(true);
          expect(can).toHaveBeenCalledWith(principal, action, subject);
        },
      );

      it.each([
        ['a user', user],
        ['an API client', client],
      ] as const)('refuses %s without the permission', async (_, principal) => {
        expect(await policyAnswering(false).policy[ability](principal)).toBe(
          false,
        );
      });
    },
  );
});
