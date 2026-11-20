import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it, vi } from 'vitest';
import { PersonPicker } from '@/components/person-picker';
import { PrincipalPicker } from '@/components/principal-picker';
import { RecordPicker } from '@/components/records/record-picker';
import { peopleHandler } from '@/test/people';
import { principalsHandler } from '@/test/principals';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';

// The pickers show neither a hint nor an error: their caller does, beside
// them. `describedBy` (the ids from `useDescribedBy`) links those texts to
// the input, so a screen reader announces them after the picker's name.

const hint = <p id="hint">Type a part of a name.</p>;
const error = <p id="error">Choose someone.</p>;

describe.each([
  [
    'person',
    () => server.use(peopleHandler([])),
    (describedBy: string | undefined) => (
      <PersonPicker
        id="picker"
        label="Member"
        value=""
        onChange={() => undefined}
        invalid
        describedBy={describedBy}
      />
    ),
  ],
  [
    'principal',
    () => server.use(principalsHandler([])),
    (describedBy: string | undefined) => (
      <PrincipalPicker
        id="picker"
        label="Member"
        value=""
        onChange={() => undefined}
        invalid
        describedBy={describedBy}
      />
    ),
  ],
  [
    'record',
    () =>
      server.use(
        http.get('/v1/lists/TestItem/options', () =>
          HttpResponse.json({ items: [] }),
        ),
      ),
    (describedBy: string | undefined) => (
      <RecordPicker
        id="picker"
        label="Member"
        subject="TestItem"
        value=""
        onChange={() => undefined}
        invalid
        describedBy={describedBy}
      />
    ),
  ],
] as const)('the %s picker', (_name, answer, picker) => {
  it('is described by the hint and the error beside it', async () => {
    answer();
    await renderComponent(
      <>
        {picker('hint error')}
        {hint}
        {error}
      </>,
    );
    const input = screen.getByRole('combobox', { name: 'Member' });
    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription(
      'Type a part of a name. Choose someone.',
    );
  });

  it('has no description when its caller gives none', async () => {
    answer();
    await renderComponent(
      <>
        {picker(undefined)}
        {hint}
      </>,
    );
    expect(
      screen.getByRole('combobox', { name: 'Member' }),
    ).toHaveAccessibleDescription('');
  });
});

describe('the record picker', () => {
  it("searches the subject's records by title as one types, a bounded page, and picks one by its id", async () => {
    const asked: URLSearchParams[] = [];
    server.use(
      http.get('/v1/lists/TestItem/options', ({ request }) => {
        const query = new URL(request.url).searchParams;
        asked.push(query);
        return HttpResponse.json({
          items: query.get('q')
            ? [
                { id: 'p1', title: 'Parent plan' },
                { id: 'p2', title: null },
              ]
            : [],
        });
      }),
    );
    const onChange = vi.fn();
    await renderComponent(
      <RecordPicker
        id="parent"
        label="Parent"
        subject="TestItem"
        value=""
        onChange={onChange}
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Parent' });
    // Dice UI takes the text a frame later: typed at once, not key by key.
    await userEvent.click(input);
    fireEvent.change(input, { target: { value: 'Par' } });
    // No title: its id.
    expect(await screen.findByRole('option', { name: 'p2' })).toBeVisible();
    await userEvent.click(screen.getByRole('option', { name: 'Parent plan' }));
    expect(onChange).toHaveBeenCalledWith('p1');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Parent' })).toHaveValue(
        'Parent plan',
      ),
    );
    const searched = asked.filter((query) => query.has('q')).at(-1);
    expect(searched?.get('q')).toBe('Par');
    expect(searched?.get('limit')).toBe('20');
    // Before any term: the first by title, without `q` (the route refuses an empty one).
    expect(asked[0]?.has('q')).toBe(false);
  });

  it("shows the current record's title, named by its id", async () => {
    const id = '0190a6a0-0000-7000-8000-000000000001';
    server.use(
      http.get('/v1/lists/TestItem/options', ({ request }) => {
        const query = new URL(request.url).searchParams;
        return HttpResponse.json({
          items:
            query.get('id') === id ? [{ id, title: 'Current parent' }] : [],
        });
      }),
    );
    await renderComponent(
      <RecordPicker
        id="parent"
        label="Parent"
        subject="TestItem"
        value={id}
        onChange={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Parent' })).toHaveValue(
        'Current parent',
      ),
    );
  });

  it('says when nothing the user may read matches', async () => {
    server.use(
      http.get('/v1/lists/TestItem/options', () =>
        HttpResponse.json({ items: [] }),
      ),
    );
    await renderComponent(
      <RecordPicker
        id="parent"
        label="Parent"
        subject="TestItem"
        value=""
        onChange={() => undefined}
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Parent' });
    // Dice UI takes the text a frame later: typed at once, not key by key.
    await userEvent.click(input);
    fireEvent.change(input, { target: { value: 'zz' } });
    expect(await screen.findByText('No match you may read.')).toBeVisible();
  });

  it('offers only the records its filter keeps', async () => {
    const asked: URLSearchParams[] = [];
    server.use(
      http.get('/v1/lists/TestItem/options', ({ request }) => {
        asked.push(new URL(request.url).searchParams);
        return HttpResponse.json({ items: [] });
      }),
    );
    await renderComponent(
      <RecordPicker
        id="parent"
        label="Parent"
        subject="TestItem"
        filter={{ status: 'done', ownerId: null }}
        value=""
        onChange={() => undefined}
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Parent' });
    await userEvent.click(input);
    fireEvent.change(input, { target: { value: 'ab' } });
    await waitFor(() =>
      expect(asked.some((q) => q.get('q') === 'ab')).toBe(true),
    );
    for (const query of asked) {
      expect(query.get('status')).toBe('done');
      // An empty value is no filter.
      expect(query.has('ownerId')).toBe(false);
    }
  });
});
