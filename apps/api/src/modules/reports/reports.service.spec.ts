import { NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { DataTransferService } from '../data-transfer/data-transfer.service.js';
import { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';
import type { ReportScheduleRow } from './reports.tables.js';

/** ReportsService's rules on a stubbed repository: no database. */
describe('ReportsService', () => {
  const repository = {
    findOwn: vi.fn(),
    lock: vi.fn(),
    update: vi.fn(),
    updateIfLastRun: vi.fn(),
  };
  const transfers = {
    startExport: vi.fn(),
    exportable: vi.fn(),
    checkExport: vi.fn(),
  };
  const audit = { record: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as RequestPrincipal;
  const report = {
    id: 'r1',
    owner: 'user:user-1',
    exporter: 'notes',
    format: 'csv',
    filters: {},
    sort: null,
    timezone: 'UTC',
    schedule: { every: 'day', hour: 6 },
    active: true,
    lastRunAt: null,
    lastTransferId: null,
    nextRunAt: new Date('2026-11-25T06:00:00Z'),
  } as unknown as ReportScheduleRow;
  let service: ReportsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: ReportsRepository, useValue: repository },
        { provide: DataTransferService, useValue: transfers },
        { provide: AuditService, useValue: audit },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      // Mail, storage, i18n, locks, tenancy and config: unused by these rules.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(ReportsService);
  });

  it("answers 404 for another's report", async () => {
    repository.findOwn.mockResolvedValue(undefined);
    await expect(service.get(user, 'r9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repository.findOwn).toHaveBeenCalledWith('user:user-1', 'r9');
  });

  it('claims nothing a second runner already moved', async () => {
    repository.lock.mockResolvedValue({
      ...report,
      nextRunAt: new Date('2026-11-26T06:00:00Z'),
    });
    await expect(
      service.start(user, report, { trigger: 'schedule' }),
    ).resolves.toBeNull();
    expect(repository.update).not.toHaveBeenCalled();
    expect(transfers.startExport).not.toHaveBeenCalled();
  });

  it('undoes the claim when the export cannot start', async () => {
    repository.lock.mockResolvedValue(report);
    repository.update.mockResolvedValue(report);
    transfers.startExport.mockRejectedValue(new Error('refused'));
    await expect(
      service.start(user, report, { trigger: 'manual' }),
    ).rejects.toThrow('refused');
    const [, transferId] = repository.updateIfLastRun.mock.calls[0]!;
    expect(repository.update).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ lastTransferId: transferId }),
    );
    expect(repository.updateIfLastRun).toHaveBeenCalledWith('r1', transferId, {
      lastRunAt: null,
      lastTransferId: null,
      nextRunAt: report.nextRunAt,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
