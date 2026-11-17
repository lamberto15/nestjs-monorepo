import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { t } from '@nestjs/i18n';
import { ProblemDetailsFilter } from '../../core/http/problem-details.filter.js';
import { UnknownCurrencyError } from './currencies.js';
import { InvalidDecimalError } from './decimal.js';
import { AmountPrecisionError, CurrencyMismatchError } from './money.js';

/**
 * The money library's errors, when one reaches a request (input a schema
 * didn't check, or mixed currencies), become problem details with a stable
 * `code` instead of a 500. The library knows no HTTP: jobs and services
 * catch them as errors. Registers when this file loads: import it where a
 * route uses money.
 */
ProblemDetailsFilter.map(
  CurrencyMismatchError,
  (error) =>
    new UnprocessableEntityException(
      {
        code: error.code,
        message: t('money.currencyMismatch', {
          args: { left: error.left, right: error.right },
        }),
      },
      { cause: error },
    ),
);

ProblemDetailsFilter.map(
  UnknownCurrencyError,
  (error) =>
    new BadRequestException(
      {
        code: error.code,
        message: t('money.unknownCurrency', {
          args: { currency: String(error.currency) },
        }),
      },
      { cause: error },
    ),
);

ProblemDetailsFilter.map(
  AmountPrecisionError,
  (error) =>
    new BadRequestException(
      {
        code: error.code,
        message: t('money.amountPrecision', {
          args: { currency: error.currency, exponent: error.exponent },
        }),
      },
      { cause: error },
    ),
);

ProblemDetailsFilter.map(
  InvalidDecimalError,
  (error) =>
    new BadRequestException(
      { code: error.code, message: t('money.invalidDecimal') },
      { cause: error },
    ),
);
