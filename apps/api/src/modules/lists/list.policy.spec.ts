import type { Principal, UserPrincipal } from '../../iam/auth/principal.js';
import { ListPolicy } from './list.policy.js';
import type { ListsService } from './lists.service.js';

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

/** The policy over a lists service that lets the principal read `readable` only. */
function policyReading(...readable: string[]) {
  const mayRead = vi.fn(async (_: Principal | null, subject: string) =>
    readable.includes(subject),
  );
  return {
    policy: new ListPolicy({ mayRead } as unknown as ListsService),
    mayRead,
  };
}

describe('ListPolicy', () => {
  it('allows reading the list of a subject the principal may read, asked for it', async () => {
    const { policy, mayRead } = policyReading('Invoice');
    expect(await policy.read(user, 'Invoice')).toBe(true);
    expect(mayRead).toHaveBeenCalledWith(user, 'Invoice');
  });

  it('refuses the list of a subject the principal may not read', async () => {
    expect(await policyReading('Customer').policy.read(user, 'Invoice')).toBe(
      false,
    );
  });

  it('refuses a guest the lists service refuses', async () => {
    expect(await policyReading().policy.read(null, 'Invoice')).toBe(false);
  });
});
