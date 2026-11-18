import type { ConfigType } from '@nestjs/config';
import type { DiscoveryService, ModuleRef } from '@nestjs/core';
import type { authConfig } from './auth.config.js';
import {
  AuthPolicy,
  type AuthPolicySource,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MIN_LENGTH_LIMIT,
} from './auth-policy.js';
import type { UsersRepository } from './users.repository.js';

describe('AuthPolicy: passwords', () => {
  const policy = (
    source: AuthPolicySource | null,
    tenants: string[] = ['t1', 't2'],
  ) => {
    const built = new AuthPolicy(
      { sessionIdleMinutes: 120, sessionMaxHours: 12 } as ConfigType<
        typeof authConfig
      >,
      {
        getProviders: () => (source ? [{ instance: source }] : []),
      } as unknown as DiscoveryService,
      {} as ModuleRef,
      {
        memberships: async () => tenants.map((id) => ({ id })),
      } as unknown as UsersRepository,
    );
    built.onModuleInit();
    return built;
  };

  it("takes the strictest of the account's tenants, between the floor and the limit", async () => {
    const lengths: Record<string, number | undefined> = { t1: 16, t2: 20 };
    const source = { passwordMinLength: async (id: string) => lengths[id] };
    expect(await policy(source).passwordMinLength({ userId: 'u' })).toBe(20);
    lengths.t2 = 500;
    expect(await policy(source).passwordMinLength({ userId: 'u' })).toBe(
      PASSWORD_MIN_LENGTH_LIMIT,
    );
    expect(await policy(source).passwordMinLength({ tenantIds: [] })).toBe(
      PASSWORD_MIN_LENGTH,
    );
    expect(await policy(null).passwordMinLength({ userId: 'u' })).toBe(
      PASSWORD_MIN_LENGTH,
    );
  });

  it('refuses a password shorter than the policy with password_too_short', async () => {
    const strict = policy({ passwordMinLength: async () => 20 });
    await expect(
      strict.assertPasswordLength('x'.repeat(19), 'newPassword', {
        tenantIds: ['t1'],
      }),
    ).rejects.toMatchObject({
      response: { code: 'password_too_short', minLength: 20 },
    });
    await strict.assertPasswordLength('x'.repeat(20), 'newPassword', {
      tenantIds: ['t1'],
    });
  });

  it('keeps no history unless a tenant asks, and break-glass allowed by default', async () => {
    expect(await policy(null).passwordHistory({ userId: 'u' })).toBe(0);
    expect(
      await policy({ passwordHistory: async () => 5 }).passwordHistory({
        userId: 'u',
      }),
    ).toBe(5);
    expect(await policy(null).allowsBreakGlass('t1')).toBe(true);
    expect(
      await policy({ allowsBreakGlass: async () => false }).allowsBreakGlass(
        't1',
      ),
    ).toBe(false);
  });
});
