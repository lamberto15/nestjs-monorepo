# modules/expressions

A small, safe expression language: what computed fields are written in, and
what any rule declared in code or written by a tenant (an automation's
condition) can evaluate. `compileExpression(source, variables)` in
`expression.ts`; its only dependency is the money value types.

```ts
const rule = compileExpression("status == 'sent' and total > 100", {
  status: 'string',
  total: 'decimal',
});
rule.type; // 'bool'
rule.reads; // ['status', 'total']: check the caller may read each
rule.evaluate({ status: 'sent', total: '120.00' }); // true
```

- **Safe:** a hand-written parser, no `eval`, `Function` or `vm`, no SQL. Only
  the operators and functions below exist; only the names it was compiled
  with can be read.
- **Typed:** compiled once against the names and their types (`int`,
  `decimal`, `money`, `string`, `bool`, `date`, `datetime`); a syntax or type
  error, an unknown name or function fails the compile (`ExpressionError`:
  `syntax`, `too_long`, `too_complex`, `too_deep`, `unknown_name`,
  `unknown_function`, `type`; `position` in the source).
- **Bounded** (`EXPRESSION_LIMITS`): 2000 characters, 200 parts, 24 levels, 30
  whole digits, strings of 10 000 characters; no loops.
- **Deterministic:** no clock, randomness, locale or I/O. Numbers are exact
  decimals (bigint): `0.1 + 0.2` is `0.3`; a division keeps 10 decimals
  (half-up), a product at most 20. Money never mixes currencies.
- **Null:** an empty input makes arithmetic, comparisons and functions null
  (`coalesce()` and `== null` test for it); `and`, `or`, `not`, `if()` read
  null as false. `evaluate` throws an `ExpressionError` (`division_by_zero`,
  `currency_mismatch`, `out_of_range`, `invalid_value`) when a value can't be
  computed. It takes values as the API shows them and answers in the API's
  form of the type.

| Syntax                                                    | Meaning                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `12`, `0.19`, `'text'`, `"text"`, `true`, `false`, `null` | literals                                                               |
| `quantity`, `createdAt`                                   | a name the expression was compiled with                                |
| `+ - * /`, unary `-`                                      | numbers; money ± money, money * or / a number, money / money (a ratio) |
| `== != < <= > >=`                                         | one type (an int compares with a decimal); comparisons don't chain     |
| `and`, `or`, `not`                                        | bools                                                                  |

Functions: `if(c, a, b)`, `coalesce(a, b, …)`, `round(x[, places])`, `floor`,
`ceil`, `abs`, `min`, `max`, `length`, `lower`, `upper`, `trim`, `concat`, `text`,
`daysBetween(a, b)`, `minutesBetween(a, b)`, `addDays(date, n)`,
`date('2026-01-31')`, `datetime('…Z')`.

No variables, no routes, no tables.

## Remove

`pnpm module:remove expressions` ([removing-a-module](../../../../../docs/removing-a-module.md)).
