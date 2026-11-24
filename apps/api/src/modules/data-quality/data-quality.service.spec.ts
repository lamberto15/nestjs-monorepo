import { ConflictException, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import { DataQualityRegistry } from './data-quality.registry.js';
import { DataQualityRepository } from './data-quality.repository.js';
import {
  DATA_QUALITY_QUEUE,
  DataQualityService,
  SCAN_BATCH,
} from './data-quality.service.js';

/** DataQualityService's rules on a stubbed repository: no database. */
describe('DataQualityService', () => {
  const repository = {
    lockRunningScan: vi.fn(),
    updateScan: vi.fn(),
    countLive: vi.fn(),
    insertScan: vi.fn(),
    findScan: vi.fn(),
    liveBatch: vi.fn(),
    addScanned: vi.fn(),
    deleteCheckedBefore: vi.fn(),
    countOpen: vi.fn(),
    findFinding: vi.fn(),
    isVisible: vi.fn(),
  };
  const registration = {
    subject: 'Note',
    recommended: [],
    duplicates: [],
    rules: [],
    record: { fields: {} },
  };
  const registry = { all: vi.fn(), find: vi.fn() };
  const access = {
    deniedFields: vi.fn(),
    conditionalFields: vi.fn(),
    sqlFilter: vi.fn(),
  };
  const queue = { add: vi.fn() };
  const audit = { record: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const scan = { id: 's1', status: 'running', createdAt: new Date(0) };
  let service: DataQualityService;

  beforeEach(async () => {
    vi.resetAllMocks();
    registry.all.mockReturnValue([registration]);
    registry.find.mockReturnValue(registration);
    access.deniedFields.mockResolvedValue([]);
    access.conditionalFields.mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        DataQualityService,
        { provide: DataQualityRepository, useValue: repository },
        { provide: DataQualityRegistry, useValue: registry },
        { provide: AccessService, useValue: access },
        { provide: AuditService, useValue: audit },
        {
          provide: Records,
          useValue: { of: () => ({ feature: { table: {} } }) },
        },
        { provide: getQueueToken(DATA_QUALITY_QUEUE), useValue: queue },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(DataQualityService);
  });

  it('starts no scan while a recent one runs', async () => {
    repository.lockRunningScan.mockResolvedValue({
      ...scan,
      createdAt: new Date(),
    });
    await expect(service.startScan(user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.insertScan).not.toHaveBeenCalled();
  });

  it('fails a lost scan and starts another, queued', async () => {
    repository.lockRunningScan.mockResolvedValue(scan);
    repository.countLive.mockResolvedValue(3);
    repository.insertScan.mockImplementation(async (values) => ({
      id: 's2',
      scanned: 0,
      ...values,
    }));
    await expect(service.startScan(user)).resolves.toMatchObject({
      id: 's2',
      status: 'queued',
      total: 3,
    });
    expect(repository.updateScan).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('asks for the next batch while a batch was full', async () => {
    repository.findScan.mockResolvedValue(scan);
    repository.liveBatch.mockResolvedValue(
      Array.from({ length: SCAN_BATCH }, (_, i) => ({ id: `r${i}` })),
    );
    const job = { tenantId: 't1', scanId: 's1', subject: 'Note' };
    await expect(service.batch(job)).resolves.toEqual({
      ...job,
      after: `r${SCAN_BATCH - 1}`,
    });
    expect(repository.addScanned).toHaveBeenCalledWith('s1', SCAN_BATCH);
    expect(repository.deleteCheckedBefore).not.toHaveBeenCalled();
  });

  it('completes the scan after its last subject, sweeping what no longer holds', async () => {
    repository.findScan.mockResolvedValue(scan);
    repository.liveBatch.mockResolvedValue([]);
    repository.countOpen.mockResolvedValue(4);
    await expect(
      service.batch({ tenantId: 't1', scanId: 's1', subject: 'Note' }),
    ).resolves.toBeNull();
    expect(repository.deleteCheckedBefore).toHaveBeenCalledWith(
      'Note',
      scan.createdAt,
    );
    expect(repository.updateScan).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ status: 'completed', findings: 4 }),
    );
  });

  it('answers 404 for a finding the principal may not see', async () => {
    repository.findFinding.mockResolvedValue({ id: 'f1', subject: 'Note' });
    repository.isVisible.mockResolvedValue(false);
    await expect(service.dismiss(user, 'f1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
