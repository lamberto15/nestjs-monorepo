import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { httpConfig } from '../../core/http/http.config.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { accountConfig } from './account.config.js';
import { AccountRepository } from './account.repository.js';
import { AccountWork } from './account-work.js';
import { PasskeysRepository } from './passkeys.repository.js';
import {
  isCrossOriginCeremony,
  MAX_PASSKEYS,
  PasskeysService,
} from './passkeys.service.js';
import { SecurityAlerts } from './security-alerts.service.js';

describe('isCrossOriginCeremony', () => {
  it('accepts a ceremony run on the page itself', () => {
    expect(isCrossOriginCeremony({ crossOrigin: false })).toBe(false);
    // Older browsers leave the member out.
    expect(isCrossOriginCeremony({})).toBe(false);
  });

  it('refuses one run in a frame of another origin, with or without a top origin', () => {
    expect(isCrossOriginCeremony({ crossOrigin: true })).toBe(true);
    expect(
      isCrossOriginCeremony({
        crossOrigin: true,
        topOrigin: 'https://evil.example',
      }),
    ).toBe(true);
  });

  it('refuses a top origin without crossOrigin (a browser bug, never trusted)', () => {
    expect(
      isCrossOriginCeremony({
        crossOrigin: false,
        topOrigin: 'https://web.example.com',
      }),
    ).toBe(true);
  });
});

/** PasskeysService's rules on stubbed repositories: no database, no Redis. */
describe('PasskeysService', () => {
  const repository = {
    list: vi.fn(),
    credentialsOf: vi.fn(),
    rename: vi.fn(),
    findOwn: vi.fn(),
    delete: vi.fn(),
  };
  const accounts = { signInMethods: vi.fn() };
  const audit = { record: vi.fn() };
  const securityAlerts = { credentialsChanged: vi.fn(), tell: vi.fn() };
  const user = {
    kind: 'user',
    id: 'u1',
    email: 'ada@example.com',
    name: 'Ada',
    emailVerified: true,
  } as UserPrincipal;
  const row = {
    id: 'p1',
    userId: 'u1',
    name: 'Laptop',
    credentialId: 'cred',
    publicKey: 'key',
    counter: 0,
    transports: ['internal'],
    deviceType: 'multiDevice',
    backedUp: true,
    aaguid: 'aaguid',
    lastUsedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  let service: PasskeysService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PasskeysService,
        { provide: PasskeysRepository, useValue: repository },
        { provide: AccountRepository, useValue: accounts },
        { provide: AuditService, useValue: audit },
        { provide: SecurityAlerts, useValue: securityAlerts },
        // The transaction is the repositories' ambient one: here, none.
        {
          provide: AccountWork,
          useValue: { run: (work: () => unknown) => work() },
        },
        {
          provide: accountConfig.KEY,
          useValue: {
            production: false,
            serviceName: 'App',
            passkeys: {
              enabled: true,
              origins: [],
              challengeTtlSeconds: 300,
              androidApps: [],
              appleApps: [],
            },
          },
        },
        {
          provide: httpConfig.KEY,
          useValue: { webUrl: 'http://localhost:5173' },
        },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(PasskeysService);
  });

  it('lists the passkeys without their key material', async () => {
    repository.list.mockResolvedValue([row]);
    const [view] = await service.list('u1');
    expect(view).toEqual(expect.objectContaining({ id: 'p1', name: 'Laptop' }));
    expect(view).not.toHaveProperty('publicKey');
    expect(view).not.toHaveProperty('credentialId');
  });

  it('refuses a registration past the limit before a challenge is made', async () => {
    repository.credentialsOf.mockResolvedValue(
      Array.from({ length: MAX_PASSKEYS }, () => ({
        credentialId: 'c',
        transports: [],
      })),
    );
    await expect(
      service.registrationOptions(user, { sessionId: 's1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("answers 404 when renaming another user's passkey, and audits nothing", async () => {
    repository.rename.mockResolvedValue(undefined);
    await expect(service.rename(user, 'p9', 'New')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repository.rename).toHaveBeenCalledWith('u1', 'p9', 'New');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('keeps the last way to sign in', async () => {
    repository.findOwn.mockResolvedValue({ id: 'p1', name: 'Laptop' });
    accounts.signInMethods.mockResolvedValue({ total: 1 });
    await expect(
      service.remove(user, 'p1', '203.0.113.1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'last_sign_in_method' }),
    });
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('answers 404 for a passkey removed meanwhile, and tells nobody', async () => {
    repository.findOwn.mockResolvedValue({ id: 'p1', name: 'Laptop' });
    accounts.signInMethods.mockResolvedValue({ total: 2 });
    repository.delete.mockResolvedValue(false);
    await expect(
      service.remove(user, 'p1', '203.0.113.1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(securityAlerts.credentialsChanged).not.toHaveBeenCalled();
  });

  it('removes a passkey and tells its owner after the change', async () => {
    repository.findOwn.mockResolvedValue({ id: 'p1', name: 'Laptop' });
    accounts.signInMethods.mockResolvedValue({ total: 2 });
    repository.delete.mockResolvedValue(true);
    const alert = { userId: 'u1', kind: 'passkeyRemoved', args: {} };
    securityAlerts.credentialsChanged.mockResolvedValue(alert);
    await service.remove(user, 'p1', '203.0.113.1');
    expect(repository.delete).toHaveBeenCalledWith('p1');
    expect(securityAlerts.credentialsChanged).toHaveBeenCalledWith(
      user,
      'u1',
      expect.objectContaining({
        action: 'auth.passkey-removed',
        details: { passkey: 'p1', name: 'Laptop' },
      }),
    );
    expect(securityAlerts.tell).toHaveBeenCalledWith(alert);
  });
});
