import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  EmailVerificationService,
  PasswordHasher,
  SessionService,
} from '@nestjs/authentication';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service.js';
import { DrizzleAuthenticationStore } from '../auth/drizzle-authentication.store.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import { AccountRepository } from './account.repository.js';
import { AccountService } from './account.service.js';
import { AccountWork } from './account-work.js';

/** AccountService's rules on a stubbed repository: no database. */
describe('AccountService', () => {
  const accounts = {
    findByEmail: vi.fn(),
    update: vi.fn(),
    liveRefreshTokens: vi.fn(),
    tokenFamiliesOf: vi.fn(),
  };
  const users = { findActiveByEmail: vi.fn() };
  const sessions = { list: vi.fn(), revoke: vi.fn() };
  const store = { revokeRefreshTokenFamily: vi.fn() };
  const hasher = { verify: vi.fn() };
  const audit = { record: vi.fn() };
  const emailVerification = { send: vi.fn() };
  const user = {
    kind: 'user',
    id: 'u1',
    email: 'admin@placeholder.invalid',
    onboarding: { email: true },
  } as unknown as UserPrincipal;
  let service: AccountService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountService,
        { provide: AccountRepository, useValue: accounts },
        { provide: UsersRepository, useValue: users },
        { provide: SessionService, useValue: sessions },
        { provide: DrizzleAuthenticationStore, useValue: store },
        { provide: PasswordHasher, useValue: hasher },
        { provide: AuditService, useValue: audit },
        { provide: EmailVerificationService, useValue: emailVerification },
        // The transaction is the repository's ambient one: here, none.
        {
          provide: AccountWork,
          useValue: { run: (work: () => unknown) => work() },
        },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(AccountService);
  });

  describe('sessions', () => {
    const app = { kind: 'user', id: 'u1' } as UserPrincipal;

    it("lists an app once per token family: its first sign-in, its last refresh's claims", async () => {
      sessions.list.mockResolvedValue([]);
      accounts.liveRefreshTokens.mockResolvedValue([
        {
          familyId: 'f1',
          createdAt: new Date(2_000),
          claims: { sid: 's1', dev: 'Phone (new)' },
        },
        {
          familyId: 'f1',
          createdAt: new Date(1_000),
          claims: { sid: 's1', dev: 'Phone' },
        },
        // Signed in before `sid` existed: can't be named, not listed.
        { familyId: 'f2', createdAt: new Date(500), claims: null },
      ]);
      const listed = await service.listSessions(app, { sid: 's1' });
      expect(listed).toEqual([
        expect.objectContaining({
          id: 's1',
          kind: 'app',
          createdAt: new Date(1_000).toISOString(),
          lastActiveAt: new Date(2_000).toISOString(),
          device: 'Phone (new)',
          current: true,
        }),
      ]);
    });

    it("signs out an app's token families when no browser session has the id", async () => {
      sessions.revoke.mockResolvedValue(false);
      accounts.tokenFamiliesOf.mockResolvedValue(['f1', 'f2']);
      await expect(service.revokeSession(app, 's1')).resolves.toBe(true);
      expect(accounts.tokenFamiliesOf).toHaveBeenCalledWith('u1', 's1');
      expect(store.revokeRefreshTokenFamily).toHaveBeenCalledTimes(2);
    });

    it('answers false for a session that is not the user’s', async () => {
      sessions.revoke.mockResolvedValue(false);
      accounts.tokenFamiliesOf.mockResolvedValue([]);
      await expect(service.revokeSession(app, 'x')).resolves.toBe(false);
      expect(store.revokeRefreshTokenFamily).not.toHaveBeenCalled();
    });
  });

  describe('the onboarding address', () => {
    const input = { email: 'Ada@Company.io', currentPassword: 'secret' };

    beforeEach(() => {
      users.findActiveByEmail.mockResolvedValue({ passwordHash: 'hash' });
    });

    it('wants the current password', async () => {
      hasher.verify.mockResolvedValue(false);
      await expect(
        service.changeOnboardingEmail(user, input),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(accounts.update).not.toHaveBeenCalled();
    });

    it('answers 409 when the unique index finds the address taken since the check', async () => {
      hasher.verify.mockResolvedValue(true);
      accounts.findByEmail.mockResolvedValue(undefined);
      accounts.update.mockRejectedValue(
        Object.assign(new Error('duplicate'), { code: '23505' }),
      );
      await expect(
        service.changeOnboardingEmail(user, input),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(audit.record).not.toHaveBeenCalled();
      expect(emailVerification.send).not.toHaveBeenCalled();
    });

    it('sets the address unproved, audits it, then sends its link', async () => {
      hasher.verify.mockResolvedValue(true);
      accounts.findByEmail.mockResolvedValue(undefined);
      accounts.update.mockResolvedValue({ id: 'u1' });
      await service.changeOnboardingEmail(user, input);
      expect(accounts.update).toHaveBeenCalledWith('u1', {
        email: 'ada@company.io',
        emailVerified: false,
      });
      expect(audit.record).toHaveBeenCalledWith(
        user,
        expect.objectContaining({ action: 'user.email-changed' }),
      );
      expect(emailVerification.send).toHaveBeenCalledWith({
        id: 'u1',
        email: 'ada@company.io',
      });
    });
  });
});
