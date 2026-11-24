import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { ExchangeRatesRepository } from './exchange-rates.repository.js';
import { RateUnavailableError } from './exchange-rates.errors.js';
import { ExchangeRatesService } from './exchange-rates.service.js';
import { Money } from './money.js';

/** ExchangeRatesService's rules on a stubbed repository: no database. */
describe('ExchangeRatesService', () => {
  const repository = {
    newestDay: vi.fn(),
    ratesOf: vi.fn(),
    newestDayWith: vi.fn(),
    ratesFor: vi.fn(),
    upsert: vi.fn(),
  };
  let service: ExchangeRatesService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ExchangeRatesService,
        { provide: ExchangeRatesRepository, useValue: repository },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(ExchangeRatesService);
  });

  it('converts a currency to itself without asking', async () => {
    const amount = Money.of('10', 'USD');
    await expect(service.convert(amount, 'USD')).resolves.toMatchObject({
      amount,
      rate: '1',
      source: 'identity',
    });
    expect(repository.newestDayWith).not.toHaveBeenCalled();
  });

  it('triangulates through the base, on the newest day with both legs', async () => {
    repository.newestDayWith.mockResolvedValue('2026-11-20');
    repository.ratesFor.mockResolvedValue([
      { currency: 'USD', rate: '1.1652' },
    ]);
    const result = await service.convert(Money.of('100', 'EUR'), 'USD', {
      day: '2026-11-22',
    });
    expect(repository.newestDayWith).toHaveBeenCalledWith(
      'ecb',
      'EUR',
      '2026-11-22',
      ['USD'],
    );
    expect(result).toMatchObject({
      amount: Money.of('116.52', 'USD'),
      rateDate: '2026-11-20',
      legs: { from: '1', to: '1.1652' },
    });
  });

  it('throws RateUnavailableError when no day has the currencies', async () => {
    repository.newestDayWith.mockResolvedValue(undefined);
    await expect(
      service.convert(Money.of('1', 'USD'), 'JPY'),
    ).rejects.toBeInstanceOf(RateUnavailableError);
  });

  it("gives null before the first fetch, else the day's rates", async () => {
    repository.newestDay.mockResolvedValue(null);
    await expect(service.ratesOn('2026-11-22')).resolves.toBeNull();
    repository.newestDay.mockResolvedValue('2026-11-20');
    repository.ratesOf.mockResolvedValue([
      { base: 'EUR', currency: 'USD', rate: '1.1652' },
    ]);
    await expect(service.ratesOn('2026-11-22')).resolves.toEqual({
      source: 'ecb',
      base: 'EUR',
      day: '2026-11-20',
      rates: { USD: '1.1652' },
    });
  });
});
