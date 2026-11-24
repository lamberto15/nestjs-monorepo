import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { sequencesConfig } from './sequences.config.js';
import { SequencesRepository } from './sequences.repository.js';
import { SequencesService } from './sequences.service.js';

/** SequencesService's rules on a stubbed repository: no database. */
describe('SequencesService', () => {
  const repository = {
    increment: vi.fn(),
    incrementFrom: vi.fn(),
    values: vi.fn(),
    lockValue: vi.fn(),
    setIfNotPast: vi.fn(),
  };
  let inTransaction = true;
  let service: SequencesService;

  beforeEach(async () => {
    vi.resetAllMocks();
    inTransaction = true;
    const moduleRef = await Test.createTestingModule({
      providers: [
        SequencesService,
        { provide: SequencesRepository, useValue: repository },
        { provide: sequencesConfig.KEY, useValue: { timezone: 'UTC' } },
        {
          provide: TransactionHost,
          useValue: {
            withTransaction: (work: () => unknown) => work(),
            isTransactionActive: () => inTransaction,
          },
        },
      ],
    }).compile();
    service = moduleRef.get(SequencesService);
  });

  it('takes a number only inside a transaction', async () => {
    inTransaction = false;
    await expect(service.next('invoice')).rejects.toThrow(/transaction/);
    expect(repository.increment).not.toHaveBeenCalled();
  });

  it('numbers per year, formatted', async () => {
    repository.increment.mockResolvedValue(42);
    await expect(
      service.next('invoice', {
        prefix: 'INV',
        perYear: true,
        width: 5,
        at: new Date('2026-06-01T00:00:00Z'),
      }),
    ).resolves.toEqual({ value: 42, formatted: 'INV-2026-00042' });
    expect(repository.increment).toHaveBeenCalledWith('invoice', '|2026');
  });

  it('carries a declared counter on into a key that has none', async () => {
    repository.values.mockResolvedValue([
      { name: 'note', scope: 'old', value: 7 },
    ]);
    await expect(
      service.peek('note', 'NOTE-', { carryFrom: 'old' }),
    ).resolves.toBe(7);
  });

  it('never sets a counter below the last value taken', async () => {
    repository.lockValue.mockResolvedValue(10);
    await expect(service.setAtLeast('note', 'k', 5)).resolves.toEqual({
      set: false,
      before: 10,
    });
    expect(repository.setIfNotPast).not.toHaveBeenCalled();
  });
});
