import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { useCurrencyDefault } from '@/lib/currency';
import { useAppForm } from '@/lib/form';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';

function Amount(props: { editing?: boolean }) {
  const form = useAppForm({ defaultValues: { totalCurrency: 'EUR' } });
  useCurrencyDefault(form, ['totalCurrency'], !props.editing);
  return (
    <form.AppField name="totalCurrency">
      {(field) => <field.TextField label="Currency" />}
    </form.AppField>
  );
}

const setting = (value: string) =>
  server.use(
    http.get('/v1/settings/money.currency', () =>
      HttpResponse.json({ key: 'money.currency', value }),
    ),
  );

describe('useCurrencyDefault', () => {
  it("starts a new amount in the tenant's currency", async () => {
    setting('PHP');
    await renderComponent(<Amount />);
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Currency' })).toHaveValue(
        'PHP',
      ),
    );
  });

  it('keeps what the person typed, and an edited record its own', async () => {
    setting('PHP');
    await renderComponent(<Amount editing />);
    const input = screen.getByRole('textbox', { name: 'Currency' });
    await userEvent.clear(input);
    await userEvent.type(input, 'USD');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(input).toHaveValue('USD');
  });

  it('falls back to EUR when the setting cannot be read', async () => {
    server.use(
      http.get('/v1/settings/money.currency', () =>
        HttpResponse.json({ status: 404 }, { status: 404 }),
      ),
    );
    await renderComponent(<Amount />);
    expect(screen.getByRole('textbox', { name: 'Currency' })).toHaveValue(
      'EUR',
    );
  });
});
