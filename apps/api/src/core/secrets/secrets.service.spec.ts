import { Test } from '@nestjs/testing';
import { EncryptionService } from '../encryption/encryption.service.js';
import { SecretsRepository } from './secrets.repository.js';
import { Secrets } from './secrets.service.js';

/** Secrets' rules on a stubbed repository and cipher: no database. */
describe('Secrets', () => {
  const repository = {
    insertIfAbsent: vi.fn(),
    valueOf: vi.fn(),
    replace: vi.fn(),
  };
  const encryption = {
    currentKeyId: undefined as string | undefined,
    keyIdOf: vi.fn(),
    encrypt: vi.fn((_column: unknown, plain: string) => `sealed:${plain}`),
    decrypt: vi.fn((_column: unknown, stored: string) =>
      stored.replace(/^sealed-old:/, ''),
    ),
  };
  let secrets: Secrets;

  beforeEach(async () => {
    vi.clearAllMocks();
    encryption.currentKeyId = undefined;
    const moduleRef = await Test.createTestingModule({
      providers: [
        Secrets,
        { provide: SecretsRepository, useValue: repository },
        { provide: EncryptionService, useValue: encryption },
      ],
    }).compile();
    secrets = moduleRef.get(Secrets);
  });

  it('keeps the value stored first, in the clear without keys', async () => {
    repository.valueOf.mockResolvedValue('theirs');
    encryption.keyIdOf.mockReturnValue(undefined);
    await expect(secrets.loadOrCreate('NAME', () => 'mine')).resolves.toBe(
      'theirs',
    );
    expect(repository.insertIfAbsent).toHaveBeenCalledWith('NAME', 'mine');
    expect(repository.replace).not.toHaveBeenCalled();
  });

  it('rewrites a value under an older key, only where it is unchanged', async () => {
    encryption.currentKeyId = 'k2';
    repository.valueOf.mockResolvedValue('sealed-old:value');
    encryption.keyIdOf.mockReturnValue('k1');
    await expect(secrets.loadOrCreate('NAME', () => 'new')).resolves.toBe(
      'value',
    );
    expect(repository.insertIfAbsent).toHaveBeenCalledWith(
      'NAME',
      'sealed:new',
    );
    expect(repository.replace).toHaveBeenCalledWith(
      'NAME',
      'sealed-old:value',
      'sealed:value',
    );
  });
});
