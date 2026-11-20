import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it, vi } from 'vitest';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';
import { RelatedPanel } from './related-panel';

// A child table: the lines of an order, added, changed and deleted in place
// through the line feature's own form (its record-form.tsx), here a stand-in.

const ORDER = '0190a6a0-7c1e-7000-8000-0000000000aa';
const forms = vi.hoisted(() => ({
  opened: [] as { id?: string; parent?: { field: string; id: string } }[],
  asked: [] as string[],
}));

vi.mock('../record-forms', () => ({
  recordFormOf: (subject: string) =>
    subject === 'OrderLine'
      ? {
          subject,
          Form: (props: {
            id?: string;
            parent?: { field: string; id: string };
            onDone: (saved?: { id: string }) => void;
          }) => {
            forms.opened.push({ id: props.id, parent: props.parent });
            return (
              <button type="button" onClick={() => props.onDone({ id: 'l3' })}>
                Save the line
              </button>
            );
          },
          useDelete: () => ({
            ask: (record: { id: string }) => forms.asked.push(record.id),
            dialog: null,
          }),
        }
      : undefined,
}));

const RELATED = {
  subject: 'OrderLine',
  path: 'order-lines',
  field: 'orderId',
  title: 'item',
  required: true,
  onDelete: 'restrict',
} as const;

function useLinesApi() {
  const listed: URLSearchParams[] = [];
  server.use(
    http.get('/v1/lists/OrderLine', () =>
      HttpResponse.json({
        subject: 'OrderLine',
        select: [
          'id',
          'item',
          'qty',
          'price',
          'orderId',
          'ownerId',
          'createdAt',
        ],
        fields: [
          {
            name: 'item',
            type: 'string',
            operators: ['eq'],
            sortable: true,
            custom: false,
          },
          {
            name: 'qty',
            type: 'number',
            operators: ['eq'],
            sortable: true,
            custom: false,
          },
          {
            name: 'priceCurrency',
            type: 'string',
            operators: ['eq'],
            sortable: false,
            custom: false,
          },
          {
            name: 'orderId',
            type: 'uuid',
            operators: ['eq'],
            ref: 'Order',
            sortable: false,
            custom: false,
          },
        ],
      }),
    ),
    http.get('/v1/order-lines', ({ request }) => {
      listed.push(new URL(request.url).searchParams);
      return HttpResponse.json({
        items: [
          {
            id: 'l1',
            item: 'Widget',
            qty: 2,
            price: { amount: '10.00', currency: 'EUR' },
            orderId: ORDER,
          },
          {
            id: 'l2',
            item: 'Service',
            qty: 1,
            price: null,
            orderId: ORDER,
            can: { update: false, delete: false },
          },
        ],
        nextCursor: null,
        total: 2,
      });
    }),
  );
  return listed;
}

describe('a child table', () => {
  it('shows the lines with their own fields, and adds one with the parent filled in', async () => {
    const listed = useLinesApi();
    await renderComponent(
      <RelatedPanel base="/v1/orders" id={ORDER} related={RELATED} />,
      {
        can: [
          'OrderLine.read',
          'OrderLine.create',
          'OrderLine.update',
          'OrderLine.delete',
        ],
      },
    );
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Widget')).toBeVisible();
    expect(within(table).getByText('10.00 EUR')).toBeVisible();
    // The parent is not repeated on each line.
    expect(
      within(table).queryByRole('columnheader', { name: 'Order' }),
    ).toBeNull();
    expect(
      within(table).getByRole('columnheader', { name: 'Qty' }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(forms.opened.at(-1)).toEqual({
      id: undefined,
      parent: { field: 'orderId', id: ORDER },
    });
    const before = listed.length;
    await userEvent.click(
      await screen.findByRole('button', { name: 'Save the line' }),
    );
    // Saved: the dialog closes and the lines are read again.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(listed.length).toBeGreaterThan(before));
  });

  it('changes and deletes a line the user may, through its own feature', async () => {
    useLinesApi();
    await renderComponent(
      <RelatedPanel base="/v1/orders" id={ORDER} related={RELATED} />,
      { can: ['OrderLine.read', 'OrderLine.update', 'OrderLine.delete'] },
    );
    await screen.findByRole('table');
    // No create permission: no Add.
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: 'Change Widget' }),
    );
    expect(forms.opened.at(-1)).toEqual({ id: 'l1', parent: undefined });
    await userEvent.keyboard('{Escape}');
    await userEvent.click(
      screen.getByRole('button', { name: 'Delete Widget' }),
    );
    expect(forms.asked).toContain('l1');
    // The row's own `can` says no: no buttons for it.
    expect(screen.queryByRole('button', { name: 'Change Service' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Service' })).toBeNull();
  });

  it('lists the lines only, when their feature registers no form', async () => {
    useLinesApi();
    server.use(
      http.get('/v1/lists/Note', () =>
        HttpResponse.json({ subject: 'Note', select: [], fields: [] }),
      ),
      http.get('/v1/notes', () =>
        HttpResponse.json({
          items: [{ id: 'n1', title: 'Called' }],
          nextCursor: null,
          total: 1,
        }),
      ),
    );
    await renderComponent(
      <RelatedPanel
        base="/v1/orders"
        id={ORDER}
        related={{ ...RELATED, subject: 'Note', path: 'notes', title: 'title' }}
      />,
      { can: ['Note.read', 'Note.create'] },
    );
    expect(await screen.findByText('Called')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });
});
