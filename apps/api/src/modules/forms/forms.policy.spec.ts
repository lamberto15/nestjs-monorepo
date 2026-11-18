import type { AccessService } from '../../iam/access/access.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { FormPolicy } from './forms.policy.js';

describe('FormPolicy', () => {
  const access = { can: vi.fn(async () => true) };
  const policy = new FormPolicy(access as unknown as AccessService);
  const user: UserPrincipal = {
    kind: 'user',
    id: 'u1',
    email: 'op@example.com',
    name: 'Op',
    emailVerified: true,
    locale: null,
    timezone: null,
    tenantId: 't1',
  };

  it('never lets a break-glass reader read responses, whatever access says', async () => {
    const reader = {
      ...user,
      breakGlass: {
        grantId: 'g1',
        tenantId: 't1',
        operatorTenantId: 'ops',
        expiresAt: new Date().toISOString(),
      },
    };
    expect(await policy.readResponses(reader)).toBe(false);
    // Published forms stay readable through the grant.
    expect(await policy.read(reader)).toBe(true);
    expect(await policy.readResponses(user)).toBe(true);
  });
});
