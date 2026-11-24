import { NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { MessagingRepository } from './messaging.repository.js';
import { MessagingService } from './messaging.service.js';

/** MessagingService's rules on a stubbed repository: no database. */
describe('MessagingService', () => {
  const repository = {
    findDeviceByToken: vi.fn(),
    updateDevice: vi.fn(),
    insertDevice: vi.fn(),
    deleteDevice: vi.fn(),
    sendablePhoneOf: vi.fn(),
    phonesByNumber: vi.fn(),
    setOptedOut: vi.fn(),
  };
  const audit = { record: vi.fn() };
  const encryption = {
    seal: () => ({ token: 'sealed', tokenIndex: 'index' }),
    decrypt: (_: unknown, value: string) => value,
  };
  const system = {
    run: (_: unknown, work: (s: object) => unknown) => work({}),
  };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const device = {
    id: 'd1',
    userId: 'user-1',
    platform: 'ios',
    name: 'Phone',
    lastSeenAt: new Date(),
    createdAt: new Date(),
  };
  let service: MessagingService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: MessagingRepository, useValue: repository },
        { provide: AuditService, useValue: audit },
        { provide: EncryptionService, useValue: encryption },
        { provide: SystemContext, useValue: system },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      // Config, limits, the queue and Redis: unused by these rules.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(MessagingService);
  });

  it('refreshes a device registered again by its owner, unaudited', async () => {
    repository.findDeviceByToken.mockResolvedValue(device);
    repository.updateDevice.mockResolvedValue(device);
    await service.registerDevice(user, {
      platform: 'ios',
      name: 'Phone',
      token: 't',
    });
    expect(repository.updateDevice).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ userId: 'user-1', token: 'sealed' }),
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("moves another person's token to the caller, audited", async () => {
    repository.findDeviceByToken.mockResolvedValue({
      ...device,
      userId: 'user-2',
    });
    repository.updateDevice.mockResolvedValue(device);
    await service.registerDevice(user, {
      platform: 'ios',
      name: 'Phone',
      token: 't',
    });
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ action: 'device.registered' }),
    );
  });

  it('answers 404 for a device that is not theirs', async () => {
    repository.deleteDevice.mockResolvedValue(false);
    await expect(service.removeDevice(user, 'd9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('sends only to a verified number, unless asked otherwise', async () => {
    repository.sendablePhoneOf.mockResolvedValue({
      phone: '+15550100',
      verifiedAt: null,
    });
    await expect(service.hasSendablePhone('user-1')).resolves.toBe(false);
  });

  it('opts out only the rows not opted out yet', async () => {
    repository.phonesByNumber.mockResolvedValue([
      { id: 'p1', userId: 'u1', optedOutAt: null },
      { id: 'p2', userId: 'u2', optedOutAt: new Date() },
    ]);
    await expect(service.optOut('+1 555 0100', 'sms')).resolves.toBe(1);
    expect(repository.setOptedOut).toHaveBeenCalledTimes(1);
    expect(repository.setOptedOut).toHaveBeenCalledWith('p1', expect.any(Date));
  });
});
