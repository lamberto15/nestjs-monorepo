import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StorageDisk } from '@nestjs/storage';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { SettingsService } from '../settings/settings.service.js';
import { BrandingRepository } from './branding.repository.js';
import { BrandingService } from './branding.service.js';

// @Transactional() needs the CLS plugin: here the methods run as written.
vi.mock('@nestjs-cls/transactional', async (actual) => ({
  ...(await actual<object>()),
  Transactional: () => () => undefined,
}));

/** BrandingService's rules on a stubbed repository: no database. */
describe('BrandingService', () => {
  const repository = {
    variants: vi.fn(),
    findLogo: vi.fn(),
    deleteLogo: vi.fn(),
  };
  const settings = {
    guardWrite: vi.fn(),
    enabled: vi.fn(),
    get: vi.fn(),
  };
  const tenancy = {
    find: vi.fn(),
    run: (_id: string, work: () => unknown) => work(),
    tenantId: () => 't1',
  };
  const disk = { get: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  let service: BrandingService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        BrandingService,
        { provide: BrandingRepository, useValue: repository },
        { provide: SettingsService, useValue: settings },
        { provide: Tenancy, useValue: tenancy },
        { provide: StorageDisk, useValue: disk },
      ],
    })
      // The audit, the files, images, policy and config: unused by these rules.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(BrandingService);
  });

  it('names the logos the tenant has', async () => {
    settings.get.mockResolvedValue(null);
    repository.variants.mockResolvedValue(['dark']);
    await expect(service.brand('t1')).resolves.toMatchObject({
      logoUrl: null,
      darkLogoUrl: '/v1/branding/t1/logo/dark',
    });
  });

  it('answers 400 for an upload without a file', async () => {
    await expect(
      service.logoUploaded(user, undefined, 'light'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 404 for the logo of a tenant that is not active', async () => {
    tenancy.find.mockResolvedValue({ id: 't1', active: false });
    await expect(service.logoFile('t1', 'light')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repository.findLogo).not.toHaveBeenCalled();
  });

  it('serves the stored type of an active tenant’s logo', async () => {
    tenancy.find.mockResolvedValue({ id: 't1', active: true });
    repository.findLogo.mockResolvedValue({
      key: 'k',
      contentType: 'image/png',
    });
    disk.get.mockResolvedValue({ size: 3, body: 'bytes' });
    await expect(service.logoFile('t1', 'light')).resolves.toEqual({
      contentType: 'image/png',
      size: 3,
      body: 'bytes',
    });
  });

  it('answers 404 when there is no logo to remove', async () => {
    settings.enabled.mockResolvedValue(false);
    repository.deleteLogo.mockResolvedValue(undefined);
    await expect(service.removeLogo(user, 'dark')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
