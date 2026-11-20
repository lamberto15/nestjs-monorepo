import { unwrap } from '@nestjs-monorepo/api-client';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';

/** The currency a new amount starts in when the setting can't be read (the API's default). */
export const FALLBACK_CURRENCY = 'EUR';

/**
 * The caller's `money.currency` setting (modules/settings, money.setting.ts):
 * the tenant's, or their unit's. Without the settings module, the fallback.
 */
export const currencyQuery = queryOptions({
  queryKey: ['settings', 'money.currency'],
  queryFn: async () => {
    try {
      const { value } = await unwrap(
        api.GET('/v1/settings/{key}', {
          params: { path: { key: 'money.currency' } },
        }),
      );
      return typeof value === 'string' ? value : FALLBACK_CURRENCY;
    } catch {
      return FALLBACK_CURRENCY;
    }
  },
  staleTime: 5 * 60_000,
  retry: false,
  meta: { errorToast: false },
});

/** The piece of a TanStack form this needs: a field's meta and its value. */
interface CurrencyForm<K extends string> {
  getFieldMeta(name: K): { isTouched?: boolean } | undefined;
  setFieldValue(
    name: K,
    value: string,
    options?: { dontUpdateMeta?: boolean },
  ): void;
}

/**
 * A new record's money inputs start in the setting's currency: each of
 * these currency fields the person hasn't touched takes it once it is
 * known. An edit (`on` false) keeps the record's own.
 */
export function useCurrencyDefault<K extends string>(
  form: CurrencyForm<K>,
  names: readonly K[],
  on: boolean,
) {
  const { data: currency } = useQuery({ ...currencyQuery, enabled: on });
  const fields = names.join(',');
  useEffect(() => {
    if (!on || !currency) return;
    for (const name of fields.split(',') as K[]) {
      if (!form.getFieldMeta(name)?.isTouched) {
        form.setFieldValue(name, currency, { dontUpdateMeta: true });
      }
    }
  }, [form, fields, on, currency]);
}
