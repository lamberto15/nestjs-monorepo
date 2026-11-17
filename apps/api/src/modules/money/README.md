# modules/money

Money without a database or a route: the library features import.

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

No variables, no tables.

## Remove

Delete this folder; expressions and fields import it.
