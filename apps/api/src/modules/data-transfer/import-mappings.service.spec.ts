import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { DataTransferRepository } from './data-transfer.repository.js';
import { MAX_MAPPINGS_PER_IMPORT } from './data-transfer.schemas.js';
import { DataTransferService } from './data-transfer.service.js';
import { ImportMappingsService } from './import-mappings.service.js';

// @Transactional() needs the CLS plugin: here the methods run as written.
vi.mock('@nestjs-cls/transactional', async (actual) => ({
  ...(await actual<object>()),
  Transactional: () => () => undefined,
}));

/** ImportMappingsService's rules on a stubbed repository: no database. */
describe('ImportMappingsService', () => {
  const repository = {
    mappings: vi.fn(),
    countMappings: vi.fn(),
    insertMapping: vi.fn(),
    deleteMapping: vi.fn(),
  };
  const transfers = { mappableColumns: vi.fn() };
  const audit = { record: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  let service: ImportMappingsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    transfers.mappableColumns.mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImportMappingsService,
        { provide: DataTransferRepository, useValue: repository },
        { provide: DataTransferService, useValue: transfers },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(ImportMappingsService);
  });

  it(`keeps at most ${MAX_MAPPINGS_PER_IMPORT} mappings per import`, async () => {
    repository.countMappings.mockResolvedValue(MAX_MAPPINGS_PER_IMPORT);
    await expect(
      service.create(user, 'notes', { name: 'Mine', mapping: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.insertMapping).not.toHaveBeenCalled();
  });

  it('saves a mapping, audited', async () => {
    repository.countMappings.mockResolvedValue(0);
    repository.insertMapping.mockImplementation(async (values) => ({
      id: 'm1',
      createdAt: new Date(0),
      ...values,
    }));
    await expect(
      service.create(user, 'notes', { name: 'Mine', mapping: {} }),
    ).resolves.toMatchObject({ id: 'm1', name: 'Mine', stale: [] });
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ action: 'importMapping.created' }),
    );
  });

  it("answers 404 for another import's mapping", async () => {
    repository.deleteMapping.mockResolvedValue(undefined);
    await expect(service.remove(user, 'notes', 'm9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repository.deleteMapping).toHaveBeenCalledWith('notes', 'm9');
  });
});
