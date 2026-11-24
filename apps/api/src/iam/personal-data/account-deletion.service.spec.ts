import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  PasswordHasher,
  SessionService,
  TokenService,
} from '@nestjs/authentication';
import { Test } from '@nestjs/testing';
import { MailQueue } from '../../core/mail/mail.queue.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { AccountDeletionRepository } from './account-deletion.repository.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { ConsentKinds } from './consent-kinds.js';
import { ConsentsService } from './consents.service.js';
import { DeletionCancelLinks } from './deletion-cancel-links.js';
import { personalDataConfig } from './personal-data.config.js';
import { PersonalDataRepository } from './personal-data.repository.js';

const user = {
  kind: 'user',
  id: 'u1',
  email: 'ada@example.com',
} as UserPrincipal;
const tenancy = { run: (_: unknown, work: () => unknown) => work() };
const transactions = {
  provide: TransactionHost,
  useValue: { withTransaction: (work: () => unknown) => work() },
};

/** AccountDeletionService's rules on a stubbed repository: no database. */
describe('AccountDeletionService', () => {
  const repository = {
    findPending: vi.fn(),
    findAccount: vi.fn(),
    insert: vi.fn(),
    lockAccount: vi.fn(),
    cancelPending: vi.fn(),
  };
  const hasher = { verify: vi.fn() };
  const audit = { record: vi.fn(), recordAccount: vi.fn() };
  const links = { verify: vi.fn(), sign: vi.fn() };
  const mail = { send: vi.fn() };
  let service: AccountDeletionService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountDeletionService,
        { provide: AccountDeletionRepository, useValue: repository },
        { provide: Tenancy, useValue: tenancy },
        { provide: AuditService, useValue: audit },
        { provide: PasswordHasher, useValue: hasher },
        { provide: SessionService, useValue: { revokeAll: vi.fn() } },
        { provide: TokenService, useValue: { revokeAll: vi.fn() } },
        { provide: MailQueue, useValue: mail },
        { provide: DeletionCancelLinks, useValue: links },
        {
          provide: personalDataConfig.KEY,
          useValue: { deletionGraceDays: 30 },
        },
        transactions,
      ],
    }).compile();
    service = moduleRef.get(AccountDeletionService);
  });

  it('returns a pending request as it is, with no new mail', async () => {
    const pending = {
      requestedAt: new Date(0),
      scheduledFor: new Date(86_400_000),
    };
    repository.findPending.mockResolvedValue(pending);
    await expect(
      service.request(user, undefined, undefined, undefined),
    ).resolves.toEqual({
      requestedAt: pending.requestedAt.toISOString(),
      scheduledFor: pending.scheduledFor.toISOString(),
    });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('wants the password of an account that has one, and audits a wrong one', async () => {
    repository.findPending.mockResolvedValue(undefined);
    repository.findAccount.mockResolvedValue({ passwordHash: 'h' });
    await expect(
      service.request(user, undefined, undefined, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    hasher.verify.mockResolvedValue(false);
    await expect(
      service.request(user, 'wrong', undefined, undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ action: 'account.deletion-refused' }),
    );
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('answers 404 when nothing is pending to cancel', async () => {
    repository.findPending.mockResolvedValue(undefined);
    await expect(service.cancel(user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a link whose request is gone, auditing nothing', async () => {
    links.verify.mockResolvedValue({ deletionId: 'd1', userId: 'u1' });
    repository.cancelPending.mockResolvedValue(false);
    await expect(service.cancelByLink('token')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.lockAccount).toHaveBeenCalledWith('u1');
    expect(audit.recordAccount).not.toHaveBeenCalled();
  });
});

/** ConsentsService's rules on a stubbed repository: no database. */
describe('ConsentsService', () => {
  const repository = { consentsByLatest: vi.fn(), withdrawConsents: vi.fn() };
  const kinds = { get: vi.fn(), assertAcceptable: vi.fn() };
  const audit = { record: vi.fn() };
  let service: ConsentsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ConsentsService,
        { provide: PersonalDataRepository, useValue: repository },
        { provide: Tenancy, useValue: tenancy },
        { provide: AuditService, useValue: audit },
        { provide: ConsentKinds, useValue: kinds },
        transactions,
      ],
    }).compile();
    service = moduleRef.get(ConsentsService);
  });

  it('shows each kind by its latest acceptance', async () => {
    repository.consentsByLatest.mockResolvedValue([
      {
        kind: 'terms',
        version: '2',
        acceptedAt: new Date(2),
        withdrawnAt: null,
      },
      {
        kind: 'terms',
        version: '1',
        acceptedAt: new Date(1),
        withdrawnAt: null,
      },
    ]);
    await expect(service.latest('u1')).resolves.toEqual([
      expect.objectContaining({ kind: 'terms', version: '2' }),
    ]);
  });

  it('never withdraws a required kind', async () => {
    kinds.get.mockReturnValue({ required: true });
    await expect(service.withdraw(user, 'terms')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'consent_required' }),
    });
    expect(repository.withdrawConsents).not.toHaveBeenCalled();
  });

  it('answers 404 for a consent not in force', async () => {
    kinds.get.mockReturnValue(undefined);
    repository.withdrawConsents.mockResolvedValue([]);
    await expect(service.withdraw(user, 'newsletter')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
