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
  // The parent's own rule for adding (a log saved through its action).
  mayAdd: true,
}));

vi.mock('@/features/watching/record-links', () => ({
  recordLinkOf: (subject: string) =>
    subject === 'OrderLine'
      ? {
          subject,
          path: (id: string) => `/order-lines/${id}`,
          list: '/order-lines',
          title: async (id: string) => id,
        }
      : undefined,
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
      : subject === 'Visit'
        ? {
            subject,
            Form: () => null,
            // Never deleted, added through the parent's own rule.
            useCanAdd: () => forms.mayAdd,
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
          'unit',
          'discount',
          'note',
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
            name: 'unit',
            type: 'string',
            operators: ['eq'],
            sortable: true,
            custom: false,
          },
          {
            name: 'discount',
            type: 'number',
            operators: ['gt'],
            sortable: true,
            custom: false,
          },
          {
            name: 'note',
            type: 'string',
            operators: ['contains'],
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
  it('pages through many, and opens them all in their own list', async () => {
    const asked: URLSearchParams[] = [];
    useLinesApi();
    server.use(
      http.get('/v1/order-lines', ({ request }) => {
        const query = new URL(request.url).searchParams;
        asked.push(query);
        const second = query.get('cursor') === 'p2';
        return HttpResponse.json({
          items: Array.from({ length: second ? 5 : 10 }, (_, i) => ({
            id: `l${second ? 11 + i : 1 + i}`,
            item: `Line ${second ? 11 + i : 1 + i}`,
            orderId: ORDER,
          })),
          nextCursor: second ? null : 'p2',
          total: 15,
        });
      }),
    );
    await renderComponent(
      <RelatedPanel base="/v1/orders/{id}" id={ORDER} related={RELATED} />,
      { can: ['OrderLine.read'] },
    );
    expect(await screen.findByText('1–10 of 15')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('11–15 of 15')).toBeVisible();
    expect(screen.getByText('Line 15')).toBeVisible();
    expect(asked.at(-1)?.get('cursor')).toBe('p2');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('1–10 of 15')).toBeVisible();
    // A link styled as a button.
    expect(
      screen.getByText('Open all').closest('a')?.getAttribute('href'),
    ).toBe(`/order-lines?orderId=${ORDER}`);
  });

  it("adds by the feature's own rule, and offers no delete for what is never deleted", async () => {
    server.use(
      http.get('/v1/lists/Visit', () =>
        HttpResponse.json({
          subject: 'Visit',
          select: ['id', 'note'],
          fields: [],
        }),
      ),
      http.get('/v1/visits', () =>
        HttpResponse.json({
          items: [{ id: 'v1', note: 'Called' }],
          nextCursor: null,
          total: 1,
        }),
      ),
    );
    const related = {
      ...RELATED,
      subject: 'Visit',
      path: 'visits',
      title: 'note',
    };
    // No Visit.create: the feature's rule says yes.
    const view = await renderComponent(
      <RelatedPanel base="/v1/orders/{id}" id={ORDER} related={related} />,
      { can: ['Visit.read', 'Visit.delete'] },
    );
    expect(await screen.findByText('Called')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Delete Called' })).toBeNull();
    view.unmount();
    forms.mayAdd = false;
    await renderComponent(
      <RelatedPanel base="/v1/orders/{id}" id={ORDER} related={related} />,
      { can: ['Visit.read', 'Visit.create'] },
    );
    expect(await screen.findByText('Called')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    forms.mayAdd = true;
  });

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
    // Every field of the line is a column: none cut off.
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Name', 'Qty', 'Price', 'Unit', 'Discount', 'Note', 'Actions']);

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
