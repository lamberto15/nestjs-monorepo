import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { REDIS } from '../../core/redis/redis.js';
import {
  APP_ATTEST_ROOTS,
  AppAttestationService,
} from './app-attestation.service.js';
import { captchaConfig } from './captcha.config.js';
import { CaptchaRepository } from './captcha.repository.js';

/** AppAttestationService's rules on a stubbed repository and Redis: no database. */
describe('AppAttestationService', () => {
  const repository = { findAppleKey: vi.fn(), countUp: vi.fn() };
  const redis = { getdel: vi.fn() };
  const attestation = { enabled: true, appleApps: [], androidApps: [] };

  const boot = async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppAttestationService,
        { provide: CaptchaRepository, useValue: repository },
        { provide: REDIS, useValue: redis },
        { provide: APP_ATTEST_ROOTS, useValue: [] },
        { provide: captchaConfig.KEY, useValue: { attestation } },
      ],
    }).compile();
    return moduleRef.get(AppAttestationService);
  };

  beforeEach(() => vi.resetAllMocks());

  it('refuses a header of no platform, spending nothing', async () => {
    const service = await boot();
    await expect(service.verify('windows abc')).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'attestation_invalid',
        reason: 'malformed',
      }),
    });
    expect(redis.getdel).not.toHaveBeenCalled();
  });

  it('refuses a challenge spent already', async () => {
    redis.getdel.mockResolvedValue(null);
    const service = await boot();
    await expect(service.verify('ios abc key sig')).rejects.toMatchObject({
      response: expect.objectContaining({ reason: 'challenge' }),
    });
  });

  it('refuses an assertion by a key never registered', async () => {
    redis.getdel.mockResolvedValue('1');
    repository.findAppleKey.mockResolvedValue(undefined);
    const service = await boot();
    await expect(service.verify('ios abc a2V5 c2ln')).rejects.toMatchObject({
      response: expect.objectContaining({ reason: 'key' }),
    });
    expect(repository.countUp).not.toHaveBeenCalled();
  });

  it('answers 404 for a challenge while off', async () => {
    attestation.enabled = false;
    const service = await boot();
    await expect(service.challenge()).rejects.toBeInstanceOf(NotFoundException);
    attestation.enabled = true;
  });
});
