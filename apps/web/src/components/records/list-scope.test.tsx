import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { NuqsTestingAdapter, type UrlUpdateEvent } from 'nuqs/adapters/testing';
import { describe, expect, it } from 'vitest';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';
import { ListScopeChip, useListScope } from './list-scope';

// A list opened from a parent's "Open all": `?orderId=<id>` narrows it.

const ORDER = '0190a6a0-7c1e-7000-8000-0000000000aa';
const REFS = { orderId: 'Order' };

function List() {
  const scope = useListScope(REFS);
  return (
    <>
      <output>{JSON.stringify(scope.query ?? null)}</output>
      <ListScopeChip scoped={scope.scoped} onClear={scope.clear} />
    </>
  );
}

function mount(search: string, updates: UrlUpdateEvent[] = []) {
  server.use(
    http.get('/v1/lists/Order/options', () =>
      HttpResponse.json({ items: [{ id: ORDER, title: 'Order 42' }] }),
    ),
  );
  return renderComponent(
    <NuqsTestingAdapter
      searchParams={search}
      onUrlUpdate={(event) => updates.push(event)}
    >
      <List />
    </NuqsTestingAdapter>,
  );
}

describe('a list narrowed to a parent', () => {
  it("sends the parent's reference as a filter, names the parent, and clears it", async () => {
    const updates: UrlUpdateEvent[] = [];
    await mount(`?orderId=${ORDER}&page=3`, updates);
    expect(screen.getByRole('status')).toHaveTextContent(
      JSON.stringify({ orderId: ORDER }),
    );
    expect(await screen.findByText('Order 42')).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: /Only those of/ }),
    );
    // Back to every record, from the first page.
    expect(updates.at(-1)?.queryString).toBe('');
  });

  it('is the whole list when the URL names no parent', async () => {
    await mount('?q=widget');
    expect(screen.getByRole('status')).toHaveTextContent('null');
    expect(screen.queryByRole('button', { name: /Only those of/ })).toBeNull();
  });
});
