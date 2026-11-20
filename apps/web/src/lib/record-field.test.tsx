import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { useAppForm } from '@/lib/form';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';

// A picker that waits for another field: a substatus, greyed out until its
// status is chosen, then offering only that status's substatuses.

const OPEN = '0190a6a0-7c1e-7000-8000-0000000000a1';
const CALLED = '0190a6a0-7c1e-7000-8000-0000000000b1';

function Form() {
  const form = useAppForm({ defaultValues: { statusId: '', substatusId: '' } });
  return (
    <form>
      <form.AppField name="statusId">
        {(f) => <f.RecordField label="Status" subject="TestStatus" />}
      </form.AppField>
      <form.Subscribe selector={(state) => state.values.statusId}>
        {(statusId) => (
          <form.AppField name="substatusId">
            {(f) => (
              <f.RecordField
                label="Substatus"
                subject="TestSubstatus"
                filter={{ statusId }}
                disabled={!statusId}
              />
            )}
          </form.AppField>
        )}
      </form.Subscribe>
    </form>
  );
}

describe('RecordField', () => {
  it('is shown greyed out while it waits for another field, then picks among what that one keeps', async () => {
    const asked: URLSearchParams[] = [];
    server.use(
      http.get('/v1/lists/TestStatus/options', () =>
        HttpResponse.json({ items: [{ id: OPEN, title: 'Open' }] }),
      ),
      http.get('/v1/lists/TestSubstatus/options', ({ request }) => {
        asked.push(new URL(request.url).searchParams);
        return HttpResponse.json({ items: [{ id: CALLED, title: 'Called' }] });
      }),
    );
    await renderComponent(<Form />);
    const substatus = () => screen.getByRole('combobox', { name: 'Substatus' });
    // In sight, with its label, but not to be picked from yet.
    expect(substatus()).toBeVisible();
    expect(substatus()).toBeDisabled();

    const status = screen.getByRole('combobox', { name: 'Status' });
    await userEvent.click(status);
    fireEvent.change(status, { target: { value: 'op' } });
    await userEvent.click(await screen.findByRole('option', { name: /Open/ }));
    await waitFor(() => expect(substatus()).toBeEnabled());
    await userEvent.click(substatus());
    expect(await screen.findByRole('option', { name: /Called/ })).toBeVisible();
    expect(asked.at(-1)?.get('statusId')).toBe(OPEN);
  });
});
