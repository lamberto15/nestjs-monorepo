import { NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { SettingsCache } from './settings.cache.js';
import { SettingsCatalog } from './settings.catalog.js';
import { SettingsPolicy } from './settings.policy.js';
import { SettingsRepository } from './settings.repository.js';
import { SettingsService } from './settings.service.js';

/** SettingsService's rules on a stubbed repository: no database. */
describe('SettingsService', () => {
  const repository = {
    deleteOverride: vi.fn(),
    findUnitId: vi.fn(),
    isMember: vi.fn(),
    clientExists: vi.fn(),
  };
  const declaration = {
    key: 'theme',
    label: 'Theme',
    default: 'light',
    scopes: ['tenant', 'unit', 'user'],
    public: false,
  };
  const catalog = { declaration: () => declaration };
  const policy = { read: vi.fn() };
  const audit = { record: vi.fn() };
  const cache = { invalidate: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  let service: SettingsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: SettingsRepository, useValue: repository },
        { provide: SettingsCatalog, useValue: catalog },
        { provide: SettingsPolicy, useValue: policy },
        { provide: AuditService, useValue: audit },
        { provide: SettingsCache, useValue: cache },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      // Tenancy, units, operators and encryption: unused by these rules.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(SettingsService);
  });

  it('hides a non-public setting from who may not read settings: 404', async () => {
    policy.read.mockResolvedValue(false);
    await expect(service.viewOf(user, 'theme')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('answers 404 for a unit the tenant does not have', async () => {
    repository.findUnitId.mockResolvedValue(undefined);
    await expect(
      service.unset(user, 'theme', 'unit', 'u9'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.deleteOverride).not.toHaveBeenCalled();
  });

  it('removes a unit value, audited with what it was, and forgets the cache', async () => {
    repository.findUnitId.mockResolvedValue('u1');
    repository.deleteOverride.mockResolvedValue({
      tenantId: 't1',
      value: 'dark',
      secret: null,
      rollout: null,
      rules: [],
    });
    await service.unset(user, 'theme', 'unit', 'u1');
    expect(repository.deleteOverride).toHaveBeenCalledWith({
      key: 'theme',
      scope: 'unit',
      scopeId: 'u1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        action: 'setting.reset',
        details: expect.objectContaining({ scope: 'unit', scopeId: 'u1' }),
      }),
    );
    expect(cache.invalidate).toHaveBeenCalledWith('t1');
  });

  it('takes a user scope only for a member of the tenant, by a well-formed key', async () => {
    await expect(
      service.unset(user, 'theme', 'user', 'user:nope'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.isMember).not.toHaveBeenCalled();
  });
});
