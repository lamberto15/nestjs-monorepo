import type { AccessService } from '../../iam/access/access.service.js';
import type {
  ClientPrincipal,
  Principal,
  UserPrincipal,
} from '../../iam/auth/principal.js';
import type { RecordDeclaration } from './record.js';
import { RecordPolicy } from './record.policy.js';

class InvoicePolicy extends RecordPolicy {}

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

/**
 * The policy of `Invoice` over an access service holding `held` actions on
 * it, each on the principal's own rows (a `mine` condition): a check with
 * no row passes on the action alone, as CASL does.
 */
function policyHolding(...held: string[]) {
  const can = vi.fn(
    async (
      principal: Principal | null,
      action: string,
      subject: string,
      row?: Record<string, unknown>,
    ) =>
      principal !== null &&
      subject === 'Invoice' &&
      held.includes(action) &&
      (row === undefined || row.createdBy === principal.id),
  );
  const record = { subject: 'Invoice' } as RecordDeclaration;
  return {
    policy: new InvoicePolicy({ can } as unknown as AccessService, record),
    can,
  };
}

describe('RecordPolicy', () => {
  describe('create', () => {
    it.each([
      ['a user', user],
      ['an API client', client],
    ] as const)('allows %s holding create on the subject', async (_, p) => {
      const { policy, can } = policyHolding('create');
      expect(await policy.create(p)).toBe(true);
      expect(can).toHaveBeenCalledWith(p, 'create', 'Invoice');
    });

    it('refuses a principal without it', async () => {
      expect(await policyHolding('read').policy.create(user)).toBe(false);
    });

    it('refuses a guest', async () => {
      expect(await policyHolding('create').policy.create(null)).toBe(false);
    });
  });

  describe.each(['read', 'update', 'delete', 'restore'] as const)(
    '%s',
    (action) => {
      const own = { id: 'r1', createdBy: user.id };
      const others = { id: 'r2', createdBy: 'u2' };

      it('allows the action on a row the condition matches, asked with the row', async () => {
        const { policy, can } = policyHolding(action);
        expect(await policy[action](user, own)).toBe(true);
        expect(can).toHaveBeenCalledWith(user, action, 'Invoice', own);
      });

      it("refuses it on another owner's row", async () => {
        expect(await policyHolding(action).policy[action](user, others)).toBe(
          false,
        );
      });

      it('asks without a row before one is loaded', async () => {
        const { policy, can } = policyHolding(action);
        expect(await policy[action](user)).toBe(true);
        expect(can).toHaveBeenCalledWith(user, action, 'Invoice', undefined);
      });

      it('refuses a principal without the action', async () => {
        expect(await policyHolding().policy[action](user, own)).toBe(false);
      });
    },
  );
});
