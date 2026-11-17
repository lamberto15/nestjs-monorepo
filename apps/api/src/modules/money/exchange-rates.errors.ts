import { UnprocessableEntityException } from '@nestjs/common';
import { t } from '@nestjs/i18n';
import { ProblemDetailsFilter } from '../../core/http/problem-details.filter.js';

/** No rate for these currencies on or before the day asked. */
export class RateUnavailableError extends Error {
  readonly code = 'rate_unavailable';
  constructor(
    readonly currencies: string[],
    readonly day: string,
    readonly source: string,
  ) {
    super(
      `No ${source} exchange rate for ${currencies.join(', ')} on or before ${day}`,
    );
    this.name = 'RateUnavailableError';
  }
}

// Registers when this file loads: the service imports it.
ProblemDetailsFilter.map(
  RateUnavailableError,
  (error) =>
    new UnprocessableEntityException(
      {
        code: error.code,
        message: t('money.rateUnavailable', {
          args: { currencies: error.currencies.join(', '), day: error.day },
        }),
      },
      { cause: error },
    ),
);
