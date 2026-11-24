# modules/money

Money: the library features import (no database, no route), and the exchange rates with their two routes.

- **`Money`** (`money.ts`): an integer of minor units and its ISO 4217 code,
  immutable. `of('12.34', 'EUR')` is exact (more decimals than the currency
  has is `AmountPrecisionError`), `ofMinor`, `fromDecimal` (rounds), `plus`,
  `minus`, `times`, `dividedBy`, `allocate`/`split` (largest remainder: parts
  add up), `compare`, `toDecimal`, `toJSON` (`{ amount, currency }`). Two
  currencies never mix (`CurrencyMismatchError`). Never built from a JS number
  with a fraction.
- **Decimals** (`decimal.ts`): bigint arithmetic, values as strings. Rounding
  happens once, by a named mode: `half-up` (default: invoices, VAT),
  `half-even`, `half-down`, `up`, `down`, `ceiling`, `floor`.
- **Currencies** (`currencies.ts`): ISO 4217's exponents (0, 2, 3, 4), not
  CLDR's display digits.
- **Formatting** (`money.format.ts`): `formatMoney(money, locale)` through
  `Intl.NumberFormat` with the decimal string, the currency's decimals and
  Latin digits unless asked.
- **Columns** (`money.columns.ts`): `moneyColumns('total')` (`total_minor` bigint,
  `total_currency` char(3)), `moneyValues`, `moneyOf`; `conversionColumns` and
  `conversionValues` for a converted amount's rate. Unit prices and rates are
  `numeric` (strings).
- **Schemas** (`money.schemas.ts`): `moneySchema` (a body), `moneyResponseSchema`,
  `decimalSchema`, `currencyCodeSchema`, `roundingSchema`.
- **Errors** (`money.errors.ts`): maps the library's errors to problem details
  (`currency_mismatch` 422, `unknown_currency`, `amount_precision`,
  `invalid_decimal` 400), texts in `i18n/en.json`. It registers when imported:
  a route that uses money imports it.

## Exchange rates

- **Table** `exchange_rates` (`money.tables.ts`): global, not a tenant's.
- **Job** (`exchange-rates.job.ts`): hourly at :07 UTC on one instance, as `system:exchange-rates`, fetches the ECB's reference rates through a `core/http-client` client: the daily document, or the 90-day history when empty, far behind or a working day is missing. Failures are logged and retried the next hour; rows are stored in one transaction.
- **Service** `ExchangeRatesService` (exported): `convert(amount, to, { day, rounding })` through the euro with one rounding (`RateUnavailableError`, `rate_unavailable` 422, in `exchange-rates.errors.ts`), `ratesOn(day)`, `store()`.
- **Routes** (`@Can.Anyone()`): `GET /v1/money/rates?date=`, `GET /v1/money/convert?amount&currency&to[&date][&rounding]`.
- **Metric** `exchange_rates_age_seconds` (core/metrics; since the Unix epoch before the first fetch).
- **Variables** (`money.config.ts`): `EXCHANGE_RATES_FETCH` (`off` for an app without money), `EXCHANGE_RATES_ECB_URL`.
- **Module** `MoneyModule` needs DatabaseModule, SharedLocksModule, MetricsModule, AuthModule.

## Remove

`pnpm module:remove money` ([removing-a-module](../../../../../docs/removing-a-module.md)).
