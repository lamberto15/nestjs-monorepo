import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { afterEach, describe, expect, it } from 'vitest';
import { RoleGrantsPicker } from '@/features/access/pickers';
import {
  bob,
  everything,
  ids,
  invitation,
  roles,
  signedInWith,
  units,
} from '@/features/access/test/fixtures';
import { unitRefsQuery } from '@/lib/list-refs';
import { peopleQuery, unitNameQuery } from '@/lib/people';
import { nav, visibleGroups } from '@/nav';
import { principalsHandler, userPrincipal } from '@/test/principals';
import { axeViolations } from '@/test/axe';
import { renderApp } from '@/test/render-app';
import { renderComponent } from '@/test/render-component';
import { allFeatures, problem, server, signedInUser } from '@/test/server';
import { findToast } from '@/test/toast';

// Tests that watch which requests go out listen to msw's events.
afterEach(() => {
  server.events.removeAllListeners();
});

/** Records what each request sent. */
function capture(
  method: 'post' | 'patch' | 'delete',
  path: string,
  status = 204,
) {
  const calls: { url: string; body: unknown }[] = [];
  server.use(
    http[method](path, async ({ request }) => {
      const text = await request.text();
      calls.push({
        url: request.url,
        body: text ? JSON.parse(text) : undefined,
      });
      return status === 204
        ? new HttpResponse(null, { status })
        : HttpResponse.json(
            {
              id: ids.invitation,
              email: 'new@example.com',
              status: 'sent',
              expiresAt: '2026-10-20T00:00:00Z',
            },
            { status },
          );
    }),
  );
  return calls;
}

describe('roles: the permission editor', () => {
  /** Opens a subject of the editor's list. */
  async function openSubject(
    user: ReturnType<typeof userEvent.setup>,
    label: string,
  ) {
    const list = await screen.findByRole('list', { name: 'Subjects' });
    await user.click(
      within(list).getByRole('button', { name: new RegExp(`^${label}`) }),
    );
    return screen.getByRole('region', { name: new RegExp(`^${label}`) });
  }

  it('creates a role from the simple choices: which records and which fields', async () => {
    signedInWith(everything);
    const created = capture('post', '/v1/access/roles', 201);
    const { router } = await renderApp('/access/roles/new');
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Name'), 'Support');
    const notes = await openSubject(user, 'Notes');
    await user.click(within(notes).getByRole('switch', { name: /See notes/ }));
    // Narrowed to "Created by me", and only the text.
    await user.click(
      within(notes).getByRole('radio', { name: 'Created by me' }),
    );
    await user.click(
      within(notes).getByRole('button', { name: 'Fields All fields' }),
    );
    await user.click(
      await screen.findByRole('checkbox', { name: /All fields/ }),
    );
    await user.click(
      screen.getByRole('checkbox', { name: /The custom fields/ }),
    );
    await user.keyboard('{Escape}');
    expect(
      within(notes).getByRole('button', { name: 'Fields 1 of 2 fields' }),
    ).toBeVisible();
    await user.click(
      within(notes).getByRole('switch', { name: /Write notes/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.body).toEqual({
      name: 'Support',
      description: '',
      permissions: [
        {
          subject: 'Note',
          action: 'read',
          conditions: [{ key: 'mine' }],
          fields: ['body'],
        },
        { subject: 'Note', action: 'create', conditions: [] },
      ],
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/access/roles'),
    );
  });

  it('describes a condition’s parameter by its hint and its problem', async () => {
    signedInWith({ ...everything, 'Expense.approve': true });
    const user = userEvent.setup();
    await renderApp('/access/roles/new');
    const expenses = await openSubject(user, 'Expenses');
    await user.click(
      within(expenses).getByRole('switch', { name: /Approve expenses/ }),
    );
    await user.click(
      within(expenses).getByRole('radio', { name: 'Up to an amount' }),
    );
    // An empty parameter is refused at once; the hint stays beside the reason.
    const amount = within(expenses).getByLabelText('Amount');
    expect(amount).toBeInvalid();
    expect(amount).toHaveAccessibleDescription(
      'An amount in cents (minor units). Enter a value.',
    );
    await user.type(amount, 'ten');
    expect(amount).toHaveAccessibleDescription(
      'An amount in cents (minor units). A whole number of cents.',
    );
    await user.clear(amount);
    await user.type(amount, '1000');
    expect(amount).toBeValid();
    expect(amount).toHaveAccessibleDescription(
      'An amount in cents (minor units).',
    );
  });

  it('does not offer to grant what the user doesn’t hold, nor grant it with Grant all', async () => {
    signedInWith({ 'Access.manageRoles': true, 'Note.read': true });
    const user = userEvent.setup();
    await renderApp('/access/roles/new');
    const notes = await openSubject(user, 'Notes');
    expect(
      within(notes).getByRole('switch', { name: /See notes/ }),
    ).not.toHaveAttribute('aria-disabled', 'true');
    expect(
      within(notes).getByRole('switch', { name: /Write notes/ }),
    ).toHaveAttribute('aria-disabled', 'true');

    await user.click(within(notes).getByRole('button', { name: 'Grant all' }));
    expect(
      within(notes).getByRole('switch', { name: /See notes/ }),
    ).toBeChecked();
    expect(
      within(notes).getByRole('switch', { name: /Write notes/ }),
    ).not.toBeChecked();
    expect(within(notes).getByText('1 of 3 actions granted.')).toBeVisible();
    const list = screen.getByRole('list', { name: 'Subjects' });
    expect(
      within(list).getByRole('button', { name: /Notes/ }),
    ).toHaveTextContent('1 of 3');

    await user.click(within(notes).getByRole('button', { name: 'Clear' }));
    expect(
      within(notes).getByRole('switch', { name: /See notes/ }),
    ).not.toBeChecked();
    expect(
      within(list).getByRole('button', { name: /Notes/ }),
    ).toHaveTextContent('None of 3');
  });

  it('switches subjects and filters them by label or key, granted or changed', async () => {
    signedInWith(everything);
    const user = userEvent.setup();
    await renderApp(`/access/roles/${ids.editor}`);
    const list = await screen.findByRole('list', { name: 'Subjects' });
    // Catalog order; the first is open.
    expect(
      within(list)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Access controlNone of 2', 'Notes2 of 3', 'ExpensesNone of 1']);
    expect(
      screen.getByRole('heading', { name: /Access control/ }),
    ).toBeVisible();
    const notes = await openSubject(user, 'Notes');
    expect(
      within(notes).getByText(
        '2 of 3 actions granted, 1 of them only on some records.',
      ),
    ).toBeVisible();

    await user.type(screen.getByLabelText('Filter permissions'), 'approve');
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: /Expenses/ })).toBeVisible();
    await user.clear(screen.getByLabelText('Filter permissions'));
    await user.type(screen.getByLabelText('Filter permissions'), 'Note.upd');
    expect(
      within(screen.getByRole('region', { name: /^Notes/ })).getAllByRole(
        'switch',
      ),
    ).toHaveLength(1);
    await user.clear(screen.getByLabelText('Filter permissions'));

    await user.click(screen.getByRole('button', { name: 'Granted' }));
    expect(screen.getByRole('button', { name: 'Granted' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      within(list)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Notes2 of 3']);
    await user.click(screen.getByRole('button', { name: 'Changed' }));
    expect(screen.getByText('No permission matches.')).toBeVisible();
  });

  it('opens on the subject the link names', async () => {
    signedInWith(everything);
    await renderApp(`/access/roles/${ids.editor}?subject=Expense`);
    expect(
      await screen.findByRole('heading', { name: /Expenses/ }),
    ).toBeVisible();
  });

  it('marks what changed, counts it, says it in words, and discards it', async () => {
    signedInWith(everything);
    const user = userEvent.setup();
    await renderApp(`/access/roles/${ids.editor}`);
    const summary = await screen.findByRole('complementary', {
      name: 'Summary',
    });
    expect(
      within(summary)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      // Can:
      'See notes, only: Created by me',
      'Write notes',
      // Cannot, by subject:
      'Create, edit and delete roles, Create users, assign roles',
      'Change notes',
      'Approve expenses',
    ]);
    expect(within(summary).getByText('Changes · 0')).toBeVisible();

    const notes = await openSubject(user, 'Notes');
    await user.click(
      within(notes).getByRole('switch', { name: /Write notes/ }),
    );
    await user.click(
      within(notes).getByRole('radio', { name: 'Every record' }),
    );
    await user.click(
      within(notes).getByRole('switch', { name: /Change notes/ }),
    );
    expect(within(notes).getAllByText('Changed')).toHaveLength(3);
    expect(screen.getByText('3 unsaved changes')).toBeVisible();
    const changes = within(summary).getByRole('heading', {
      name: 'Changes · 3',
    }).parentElement!;
    expect(
      within(changes)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '~Changed: See notes',
      '−Taken away: Write notes',
      '+Granted: Change notes',
    ]);

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText(/unsaved change/)).not.toBeInTheDocument();
    expect(within(notes).queryByText('Changed')).not.toBeInTheDocument();
    expect(
      within(notes).getByRole('switch', { name: /Write notes/ }),
    ).toBeChecked();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  });

  it('keeps rules the simple choice can’t express, and edits them rule by rule', async () => {
    signedInWith(everything);
    const editor = roles.find((role) => role.id === ids.editor)!;
    const stored = [
      // Either rule grants it: mine, or in my units.
      { subject: 'Note', action: 'read', conditions: [{ key: 'mine' }] },
      { subject: 'Note', action: 'read', conditions: [{ key: 'inMyUnits' }] },
      // Both conditions must hold.
      {
        subject: 'Note',
        action: 'update',
        conditions: [{ key: 'mine' }, { key: 'draft' }],
      },
    ];
    server.use(
      http.get('/v1/access/roles/:id', () =>
        HttpResponse.json({ ...editor, permissions: stored }),
      ),
    );
    const saved = capture('patch', '/v1/access/roles/:id');
    const user = userEvent.setup();
    await renderApp(`/access/roles/${ids.editor}`);
    const notes = await openSubject(user, 'Notes');
    expect(
      within(notes).getAllByText(
        'This permission has several rules or conditions, so it is edited rule by rule.',
      ),
    ).toHaveLength(2);
    expect(within(notes).queryByRole('radio')).toBeNull();
    expect(
      within(notes).getAllByRole('group', { name: 'Rule 2' }),
    ).toHaveLength(1);
    const summary = screen.getByRole('complementary', { name: 'Summary' });
    expect(
      within(summary).getByText(
        'See notes, only: Created by me or In my units',
      ),
    ).toBeVisible();
    expect(
      within(summary).getByText(
        'Change notes, only: Created by me and Still a draft',
      ),
    ).toBeVisible();

    // Down to one rule: the simple choice is back, on the rule that is left.
    const [, second] = within(notes).getAllByRole('group', { name: /Rule/ });
    await user.click(
      within(second!).getByRole('button', { name: 'Remove this rule' }),
    );
    expect(
      within(notes).getByRole('radio', { name: 'Created by me' }),
    ).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    // Saved untouched but for the name: every rule goes back as it came.
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Editors');
    await user.click(screen.getByRole('button', { name: 'Save role' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.body).toEqual({
      name: 'Editors',
      description: 'Writes records.',
      permissions: stored,
    });
  });

  it('opens the rule editor of a simple permission on demand, to add a rule', async () => {
    signedInWith(everything);
    const user = userEvent.setup();
    await renderApp(`/access/roles/${ids.editor}`);
    const notes = await openSubject(user, 'Notes');
    await user.click(
      within(notes).getByRole('button', {
        name: 'Advanced: several rules or conditions',
      }),
    );
    await user.click(within(notes).getByRole('button', { name: 'Add a rule' }));
    expect(within(notes).queryByRole('radio')).toBeNull();
    expect(within(notes).getByRole('group', { name: 'Rule 2' })).toBeVisible();
  });

  it('shows a built-in role read-only', async () => {
    signedInWith(everything);
    await renderApp(`/access/roles/${ids.admin}`);
    expect(
      await screen.findByText(
        "This role is built in: it can't be changed or deleted.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save role' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Grant all' })).toBeNull();
    expect(
      within(screen.getByRole('complementary', { name: 'Summary' })).getByText(
        'Everything, including access control',
      ),
    ).toBeVisible();
  });

  it('breaks none of the checked accessibility rules', async () => {
    signedInWith(everything);
    const user = userEvent.setup();
    await renderApp(`/access/roles/${ids.editor}`);
    await openSubject(user, 'Notes');
    expect(
      await axeViolations([
        'aria-allowed-attr',
        'aria-valid-attr-value',
        'button-name',
        'label',
        'list',
        'listitem',
        'nested-interactive',
        'duplicate-id',
      ]),
    ).toEqual([]);
  });
});

describe('roles: the comparison grid', () => {
  /** The cell of a role for an action, by its accessible name. */
  const cell = (role: string, action: string) =>
    screen.getByRole('link', { name: new RegExp(`^${role}, ${action}:`) });

  it('shows what each role grants of each permission, the built-in one everything', async () => {
    signedInWith(everything);
    await renderApp('/access/roles');
    expect(
      await screen.findByRole('columnheader', { name: /Editor/ }),
    ).toHaveTextContent('Editor2 members');
    expect(cell('Administrator', 'Approve expenses')).toHaveAccessibleName(
      'Administrator, Approve expenses: Every record',
    );
    expect(cell('Editor', 'See notes')).toHaveAccessibleName(
      'Editor, See notes: some records (Created by me)',
    );
    expect(cell('Viewer', 'See notes')).toHaveAccessibleName(
      'Viewer, See notes: Every record',
    );
    expect(cell('Viewer', 'Write notes')).toHaveAccessibleName(
      'Viewer, Write notes: Not granted',
    );
    // A cell opens that role's editor on its subject.
    expect(cell('Editor', 'See notes')).toHaveAttribute(
      'href',
      `/access/roles/${ids.editor}?subject=Note`,
    );
    expect(
      await axeViolations([
        'scope-attr-valid',
        'th-has-data-cells',
        'td-headers-attr',
        'link-name',
        'button-name',
        'label',
        'aria-allowed-attr',
      ]),
    ).toEqual([]);
  });

  it('collapses the subjects where roles agree, and keeps only rows that differ', async () => {
    signedInWith(everything);
    server.use(
      http.get('/v1/access/roles', () =>
        HttpResponse.json({
          items: roles.filter((role) => role.id !== ids.admin),
        }),
      ),
    );
    const user = userEvent.setup();
    await renderApp('/access/roles');
    // Editor and Viewer grant nothing of Access: closed; they differ on notes.
    const access = await screen.findByRole('button', {
      name: /Access control/,
    });
    expect(access).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('rowheader', { name: /Create users/ }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: /^Notes/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(
      screen.getByRole('rowheader', { name: /Change notes/ }),
    ).toBeVisible();

    await user.click(
      screen.getByRole('checkbox', { name: 'Only rows where roles differ' }),
    );
    expect(
      screen.queryByRole('rowheader', { name: /Change notes/ }),
    ).toBeNull();
    expect(screen.getByRole('rowheader', { name: /See notes/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Access control/ })).toBeNull();

    await user.click(
      screen.getByRole('checkbox', { name: 'Only rows where roles differ' }),
    );
    await user.click(screen.getByRole('button', { name: /Access control/ }));
    expect(
      screen.getByRole('rowheader', { name: /Create users/ }),
    ).toBeVisible();
  });

  it('filters the permissions by label or key', async () => {
    signedInWith(everything);
    const user = userEvent.setup();
    await renderApp('/access/roles');
    await user.type(
      await screen.findByLabelText('Filter permissions'),
      'Expense.app',
    );
    expect(
      screen
        .getAllByRole('rowheader')
        .filter((header) => header.getAttribute('scope') === 'row')
        .map((header) => header.textContent),
    ).toEqual(['Approve expensesExpense.approve']);
    await user.clear(screen.getByLabelText('Filter permissions'));
    await user.type(screen.getByLabelText('Filter permissions'), 'nothing');
    expect(screen.getByText('No permission matches.')).toBeVisible();
  });

  it('opens a role’s editor from a cell, and deletes a custom role from its column', async () => {
    signedInWith(everything);
    const deleted = capture('delete', '/v1/access/roles/:id');
    const user = userEvent.setup();
    const { router } = await renderApp('/access/roles');
    expect(
      screen.queryByRole('button', { name: 'Delete the role Administrator' }),
    ).toBeNull();
    await user.click(
      await screen.findByRole('button', { name: 'Delete the role Viewer' }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() => expect(deleted).toHaveLength(1));
    expect(deleted[0]!.url).toContain(ids.viewer);
    expect(await findToast('Role Viewer deleted.')).toBeVisible();

    await user.click(cell('Editor', 'Approve expenses'));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/access/roles/${ids.editor}`,
      ),
    );
    expect(
      await screen.findByRole('heading', { name: /Expenses/ }),
    ).toBeVisible();
  });
});

describe('grants: the role picker', () => {
  const editor = roles.find((role) => role.id === ids.editor)!;
  const render = (until: string) =>
    renderComponent(
      <RoleGrantsPicker
        roles={[editor]}
        value={{ [editor.id]: until }}
        onChange={() => undefined}
        idPrefix="test"
      />,
    );

  it('describes the end of a grant by its hint', async () => {
    await render('2999-01-01T09:00');
    const until = screen.getByLabelText('Until (optional)');
    expect(until).toBeValid();
    expect(until).toHaveAccessibleDescription('Your local time.');
  });

  it('describes an end in the past by why it is refused', async () => {
    await render('2020-01-01T09:00');
    const until = screen.getByLabelText('Until (optional)');
    expect(until).toBeInvalid();
    expect(until).toHaveAccessibleDescription('Pick a time in the future.');
  });
});

describe('users: invitations', () => {
  it('invites an address with a role, and revokes a pending invitation', async () => {
    signedInWith(everything);
    const sent = capture('post', '/v1/access/users', 202);
    // The invitation pending once the invite is sent.
    server.use(
      http.get('/v1/access/invitations', () =>
        HttpResponse.json({ items: [invitation] }),
      ),
    );
    await renderApp('/access/users');
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', { name: 'Invite member' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Email'), 'new@example.com');
    await user.click(within(dialog).getByRole('checkbox', { name: /Editor/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /North/ }));
    await user.click(
      within(dialog).getByRole('button', { name: 'Send invitation' }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({
      email: 'new@example.com',
      roleIds: [ids.editor],
      roleExpiresAt: {},
      unitIds: [ids.north],
      send: true,
    });

    const revoked = capture('delete', '/v1/access/invitations/:id');
    await screen.findByRole('heading', { name: 'Invitations' });
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Revoke',
      }),
    );
    await waitFor(() => expect(revoked).toHaveLength(1));
    expect(revoked[0]!.url).toMatch(`/v1/access/invitations/${ids.invitation}`);
  });
});

describe('users: preparing a member', () => {
  it('saves roles without an address and sends nothing; the prepared one is sent from its row', async () => {
    signedInWith(everything);
    const prepared = capture('post', '/v1/access/users', 202);
    server.use(
      http.get('/v1/access/invitations', () =>
        HttpResponse.json({
          items: [
            {
              ...invitation,
              email: null,
              status: 'prepared',
              sentAt: null,
              expiresAt: null,
            },
          ],
        }),
      ),
    );
    await renderApp('/access/users');
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', { name: 'Prepare member' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /Editor/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(prepared).toHaveLength(1));
    expect(prepared[0]!.body).toEqual({
      roleIds: [ids.editor],
      roleExpiresAt: {},
      send: false,
    });

    // Listed as prepared; without an address it can't be sent yet.
    const row = (await screen.findByText('No address yet')).closest('tr')!;
    expect(row).toHaveTextContent('Prepared');
    expect(within(row).getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('changes only what was edited', async () => {
    signedInWith(everything);
    const changed = capture('patch', '/v1/access/invitations/:id', 200);
    server.use(
      http.get('/v1/access/invitations', () =>
        HttpResponse.json({ items: [invitation] }),
      ),
    );
    await renderApp('/access/users');
    const user = userEvent.setup();
    const row = (await screen.findByText('new@example.com')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const email = within(dialog).getByLabelText(/Email/);
    await user.clear(email);
    await user.type(email, 'other@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(changed).toHaveLength(1));
    expect(changed[0]!.body).toEqual({ email: 'other@example.com' });
  });
});

describe('a name over 120 characters', () => {
  it.each([
    {
      form: 'the invitation form',
      page: '/access/users',
      post: '/v1/access/users',
      status: 202,
      open: 'Invite member',
      email: true,
      field: 'Name (optional)',
      submit: 'Send invitation',
    },
    {
      form: 'the unit form',
      page: '/access/organization',
      post: '/v1/access/organizational-units',
      status: 201,
      open: 'New unit',
      email: false,
      field: 'Name',
      submit: 'Create unit',
    },
  ])('is refused by $form before sending', async (form) => {
    signedInWith(everything);
    const sent = capture('post', form.post, form.status);
    await renderApp(form.page);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: form.open }));
    const dialog = await screen.findByRole('dialog');
    if (form.email) {
      await user.type(
        within(dialog).getByLabelText('Email'),
        'new@example.com',
      );
    }
    await user.click(within(dialog).getByLabelText(form.field));
    await user.paste('x'.repeat(121));
    await user.click(within(dialog).getByRole('button', { name: form.submit }));
    expect(
      await within(dialog).findByText('At most 120 characters.'),
    ).toBeVisible();
    expect(sent).toEqual([]);
  });
});

describe('users: resending an invitation', () => {
  it('resends through its own route (a recent sign-in asked first) and shows when its roles end', async () => {
    signedInWith(everything);
    server.use(
      http.get('/v1/access/invitations', () =>
        HttpResponse.json({ items: [invitation] }),
      ),
    );
    const invited = capture('post', '/v1/access/users', 202);
    // The first try is refused for an old sign-in; the dialog confirms it's
    // Ada, then the same request goes again.
    let tries = 0;
    const resent: string[] = [];
    server.use(
      http.post('/v1/access/invitations/:id/send', ({ request }) => {
        tries += 1;
        if (tries === 1) {
          return HttpResponse.json(
            {
              status: 403,
              code: 'reauthentication_required',
              detail: 'Confirm it is you.',
              methods: ['password'],
            },
            {
              status: 403,
              headers: { 'content-type': 'application/problem+json' },
            },
          );
        }
        resent.push(request.url);
        return HttpResponse.json(
          {
            id: ids.invitation,
            email: invitation.email,
            status: 'sent',
            expiresAt: '2026-10-25T00:00:00.000Z',
          },
          { status: 202 },
        );
      }),
      http.post('/v1/auth/reauthenticate', () =>
        HttpResponse.json({ ok: true }),
      ),
    );
    await renderApp('/access/users');
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Invitations' });
    const row = (await screen.findByText('new@example.com')).closest('tr')!;
    expect(row).toHaveTextContent('Editor');
    expect(row).toHaveTextContent(/Viewer · until/);
    expect(row).not.toHaveTextContent(/Editor · until/);

    await user.click(within(row).getByRole('button', { name: 'Resend' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Resend',
      }),
    );
    const reauth = await screen.findByRole('dialog', { name: /confirm/i });
    await user.type(within(reauth).getByLabelText(/Password/), 'secret');
    await user.click(within(reauth).getByRole('button', { name: /Confirm/ }));

    await findToast('A new link was sent to new@example.com.');
    expect(resent).toHaveLength(1);
    expect(resent[0]).toMatch(`/v1/access/invitations/${ids.invitation}/send`);
    // Never a second invitation in its place.
    expect(invited).toHaveLength(0);
  });
});

describe('users: roles of a member', () => {
  it('assigns a role; an ended grant isn’t sent back (it would come back for good)', async () => {
    signedInWith(everything);
    const changed = capture('patch', '/v1/access/users/:id');
    await renderApp('/access/users');
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', { name: /Bob Builder/ }),
    );
    const sheet = await screen.findByRole('dialog');
    // Viewer ended: not ticked, listed as ended.
    expect(
      within(sheet).getByRole('checkbox', { name: /Viewer/ }),
    ).not.toBeChecked();
    expect(within(sheet).getByText(/Ended grants.*Viewer/)).toBeVisible();
    await user.click(
      within(sheet).getByRole('checkbox', { name: /Administrator/ }),
    );
    await user.click(within(sheet).getByRole('button', { name: 'Save roles' }));

    await waitFor(() => expect(changed).toHaveLength(1));
    expect(changed[0]!.url).toMatch(`/v1/access/users/${ids.bob}`);
    expect(changed[0]!.body).toEqual({
      roleIds: [ids.editor, ids.admin],
      roleExpiresAt: {},
    });
  });

  it('removes a member from the tenant (deactivates the membership)', async () => {
    signedInWith(everything);
    const changed = capture('patch', '/v1/access/users/:id');
    await renderApp('/access/users');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Bob Builder/ }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Remove from this workspace' }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Remove',
      }),
    );
    await waitFor(() => expect(changed).toHaveLength(1));
    expect(changed[0]!.body).toEqual({ active: false });
  });
});

describe('roles: one role', () => {
  it('reads the role on its own, not from the list', async () => {
    signedInWith(everything);
    let listed = 0;
    server.use(
      http.get('/v1/access/roles', () => {
        listed += 1;
        return HttpResponse.json({ items: [] });
      }),
    );
    await renderApp(`/access/roles/${ids.editor}`);
    expect(
      await screen.findByRole('heading', { name: 'Editor' }),
    ).toBeVisible();
    expect(await screen.findByLabelText('Name')).toHaveValue('Editor');
    expect(listed).toBe(0);
  });

  it('saves with the ETag it read; a role saved meanwhile is a 412 that keeps the edits until Reload (#749)', async () => {
    signedInWith(everything);
    const editor = roles.find((role) => role.id === ids.editor)!;
    let version = 1;
    const ifMatch: (string | null)[] = [];
    server.use(
      http.get('/v1/access/roles/:id', () =>
        HttpResponse.json(
          { ...editor, description: `v${version}` },
          { headers: { ETag: `"v${version}"` } },
        ),
      ),
      http.patch('/v1/access/roles/:id', ({ request }) => {
        ifMatch.push(request.headers.get('If-Match'));
        return problem(412, 'precondition_failed');
      }),
    );
    await renderApp(`/access/roles/${ids.editor}`);
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Editors');
    // Another administrator saves meanwhile.
    version = 2;
    await user.click(screen.getByRole('button', { name: 'Save role' }));

    expect(await screen.findByText('This role changed')).toBeVisible();
    expect(ifMatch).toEqual(['"v1"']);
    expect(screen.getByLabelText('Name')).toHaveValue('Editors');
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Description')).toHaveValue('v2'),
    );
    expect(screen.getByLabelText('Name')).toHaveValue('Editor');
    expect(screen.queryByText('This role changed')).not.toBeInTheDocument();
  });

  it('says so when there is no such role (404)', async () => {
    signedInWith(everything);
    await renderApp('/access/roles/00000000-0000-7000-8000-00000000ffff');
    expect(
      await screen.findByText("This role doesn't exist (any more)."),
    ).toBeVisible();
  });
});

describe('users: the members', () => {
  it('asks the list for the members by the list state: unit filter and sort', async () => {
    signedInWith(everything);
    const asked: URL[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/access/users') asked.push(url);
    });
    await renderApp(`/access/users?unitId=in.${ids.sales}&sort=email.asc`);
    // Carol is in no unit: only Sales' members are listed.
    expect(await screen.findByText('Bob Builder')).toBeVisible();
    expect(screen.queryByText('Carol Admin')).toBeNull();
    const last = asked.at(-1)!;
    expect(JSON.parse(last.searchParams.get('filter') ?? 'null')).toEqual({
      and: [{ field: 'unitId', op: 'in', value: [ids.sales] }],
    });
    expect(last.searchParams.get('sort')).toBe('email');
    // The columns shown are the fields asked for.
    expect(last.searchParams.get('fields')).toBe('name,email,roles,active');
    expect(last.searchParams.get('page')).toBe('1');
  });

  it('filters by a unit picked in the filter menu, named by the units route', async () => {
    signedInWith(everything);
    const asked: URL[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/access/users') asked.push(url);
    });
    await renderApp('/access/users');
    const user = userEvent.setup();
    expect(await screen.findByText('Carol Admin')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Filter/ }));
    await user.click(await screen.findByRole('button', { name: 'Add filter' }));
    // The first filterable column is the name: pick the unit instead.
    const menu = await screen.findByRole('dialog');
    await user.click(within(menu).getByRole('button', { name: 'Name' }));
    await user.click(await screen.findByRole('option', { name: 'Unit' }));
    await user.click(
      await screen.findByRole('button', { name: /Unit filter value/i }),
    );
    await user.click(await screen.findByRole('option', { name: 'Sales' }));
    await waitFor(() => expect(screen.queryByText('Carol Admin')).toBeNull());
    expect(screen.getByText('Bob Builder')).toBeVisible();
    expect(
      JSON.parse(asked.at(-1)!.searchParams.get('filter') ?? 'null'),
    ).toEqual({ and: [{ field: 'unitId', op: 'in', value: [ids.sales] }] });
  });

  it('opens the member sheet from the row’s menu, where access is removed or restored', async () => {
    signedInWith(everything);
    const changed = capture('patch', '/v1/access/users/:id');
    await renderApp('/access/users');
    const user = userEvent.setup();
    await screen.findByText('Bob Builder');
    await user.click(
      screen.getAllByRole('button', { name: /open actions/i })[0]!,
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Open' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('bob@example.com')).toBeVisible();
    await user.click(
      await within(sheet).findByRole('button', {
        name: 'Remove from this workspace',
      }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Remove',
      }),
    );
    await waitFor(() => expect(changed).toHaveLength(1));
    expect(changed[0]!.url).toMatch(`/v1/access/users/${ids.bob}`);
  });

  it('opens a member as the API reads them, not as the row had them', async () => {
    signedInWith(everything);
    server.use(
      http.get('/v1/access/users/:id', () =>
        HttpResponse.json({
          ...bob,
          updatedAt: '2026-10-02T10:00:00.000Z',
          unitIds: [ids.north],
        }),
      ),
    );
    await renderApp('/access/users');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Bob Builder/ }),
    );
    const sheet = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(
        within(sheet).getByRole('checkbox', { name: 'North' }),
      ).toBeChecked(),
    );
    expect(
      within(sheet).getByRole('checkbox', { name: 'Sales' }),
    ).not.toBeChecked();
  });
});

describe('units: the organization structure', () => {
  it('shows each unit with its type, and SCIM-managed ones marked', async () => {
    signedInWith(everything);
    server.use(
      http.get('/v1/access/organizational-units', () =>
        HttpResponse.json({
          items: [{ ...units[0]!, managedByScim: true }, units[1]],
        }),
      ),
    );
    await renderApp('/access/organization');
    expect(await screen.findByRole('link', { name: 'Sales' })).toBeVisible();
    expect(screen.getByText('Division')).toBeVisible();
    expect(screen.getByText('Team')).toBeVisible();
    expect(screen.getAllByText('Managed by SCIM')).toHaveLength(1);
  });

  it('says why a unit that is not empty is not deleted', async () => {
    signedInWith(everything);
    server.use(
      http.delete('/v1/access/organizational-units/:id', () =>
        HttpResponse.json(
          { status: 409, code: 'unit_not_empty', detail: 'Move it first.' },
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
      ),
    );
    await renderApp('/access/organization');
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Sales' });
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await findToast(/still has units under it/);
  });

  it('creates a unit with its type', async () => {
    signedInWith(everything);
    const created = capture('post', '/v1/access/organizational-units', 201);
    await renderApp('/access/organization');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New unit' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Support');
    await user.click(
      within(dialog).getByRole('button', { name: 'Create unit' }),
    );
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.body).toEqual({
      type: 'team',
      name: 'Support',
      parentId: null,
    });
  });
});

const at = '2026-10-01T10:00:00.000Z';

describe('units: a unit’s members', () => {
  it('lists the unit’s members with their role, and adds someone found by search', async () => {
    signedInWith(everything);
    server.use(
      principalsHandler([
        userPrincipal({
          id: ids.carol,
          email: 'carol@example.com',
          name: 'Carol Admin',
        }),
      ]),
    );
    const added = capture(
      'post',
      '/v1/access/organizational-units/:id/members',
      201,
    );
    await renderApp(`/access/organization/${ids.north}`);
    const user = userEvent.setup();
    expect(await screen.findByText('Nobody is in this unit.')).toBeVisible();

    await user.type(screen.getByLabelText('Add a member'), 'carol');
    await user.click(await screen.findByRole('option', { name: /Carol/ }));
    await user.type(screen.getByLabelText(/Starts/), '2027-01-01T09:00');
    await user.type(screen.getByLabelText(/Ends/), '2027-06-30T17:00');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await findToast('Member added.');
    expect(added).toHaveLength(1);
    expect(added[0]!.url).toMatch(
      `/v1/access/organizational-units/${ids.north}/members`,
    );
    expect(added[0]!.body).toEqual({
      userId: ids.carol,
      role: 'member',
      validFrom: new Date('2027-01-01T09:00').toISOString(),
      validTo: new Date('2027-06-30T17:00').toISOString(),
    });
  });

  it('changes a member’s role and ends a membership', async () => {
    signedInWith(everything);
    server.use(
      principalsHandler([]),
      http.get('/v1/access/organizational-units/:id/members', () =>
        HttpResponse.json({
          items: [
            {
              id: 'm1',
              unitId: ids.north,
              userId: ids.carol,
              name: 'Carol Admin',
              email: 'carol@example.com',
              role: 'member',
              validFrom: at,
              validTo: null,
              createdAt: at,
              updatedAt: at,
            },
            {
              id: 'm0',
              unitId: ids.north,
              userId: ids.bob,
              name: 'Bob Former',
              email: 'bob@example.com',
              role: 'lead',
              validFrom: '2026-09-01T10:00:00.000Z',
              validTo: at,
              createdAt: at,
              updatedAt: at,
            },
          ],
        }),
      ),
    );
    server.use(
      http.post(
        '/v1/access/organizational-units/:id/members/:userId/impact',
        () => HttpResponse.json({ changes: [], truncated: false }),
      ),
    );
    const changed = capture(
      'patch',
      '/v1/access/organizational-units/:id/members/:userId',
      200,
    );
    const ended = capture(
      'delete',
      '/v1/access/organizational-units/:id/members/:userId',
    );
    await renderApp(`/access/organization/${ids.north}`);
    const user = userEvent.setup();
    expect(await screen.findByText('Carol Admin')).toBeVisible();
    expect(screen.getByText('carol@example.com')).toBeVisible();
    // An ended membership is history: not listed, so not changed or removed.
    expect(screen.queryByText('Bob Former')).toBeNull();

    // The first is the one that picks the role of a new member.
    await user.click(screen.getAllByRole('combobox', { name: 'Role' })[1]!);
    await user.click(await screen.findByRole('option', { name: 'Lead' }));
    // What the change would do to people's reach, then confirmed.
    expect(
      await screen.findByText(
        'No one would gain or lose access through their units.',
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Change role' }));
    await findToast('Role changed.');
    expect(changed[0]!.body).toEqual({ role: 'lead' });
    expect(changed[0]!.url).toMatch(`/members/${ids.carol}`);

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await findToast('Member removed.');
    expect(ended[0]!.url).toMatch(`/members/${ids.carol}`);
  });
});

describe('after an access change', () => {
  it('reads again what shows units and people, and what the user may do', async () => {
    signedInWith(everything);
    const reads: string[] = [];
    server.events.on('request:start', ({ request }) => {
      reads.push(new URL(request.url).pathname);
    });
    server.use(
      principalsHandler([
        userPrincipal({
          id: ids.carol,
          email: 'carol@example.com',
          name: 'Carol Admin',
        }),
      ]),
    );
    capture('post', '/v1/access/organizational-units/:id/members', 201);
    const { queryClient } = await renderApp(
      `/access/organization/${ids.north}`,
    );
    const user = userEvent.setup();
    await screen.findByText('Nobody is in this unit.');
    // What other pages cached: a unit's name (30 minutes), the filters'
    // unit options, the people a picker found.
    const cached = [
      unitNameQuery(ids.north).queryKey,
      unitRefsQuery.queryKey,
      peopleQuery('carol').queryKey,
    ];
    for (const queryKey of cached) queryClient.setQueryData(queryKey, []);
    const meReads = () => reads.filter((p) => p === '/v1/auth/me').length;
    const before = meReads();

    await user.type(screen.getByLabelText('Add a member'), 'carol');
    await user.click(await screen.findByRole('option', { name: /Carol/ }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await findToast('Member added.');

    for (const queryKey of cached) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
    // A role or a unit may have changed what the user is allowed (`can`).
    await waitFor(() => expect(meReads()).toBeGreaterThan(before));
  });
});

describe('gating', () => {
  it('shows each entry to whoever may read it', () => {
    const labels = (can: Record<string, boolean>) =>
      visibleGroups(nav, allFeatures, can)
        .flatMap((group) => group.items)
        .map((item) => item.to)
        .filter((to) => to.startsWith('/access'));
    expect(labels({ 'Access.manageUsers': true })).toEqual([
      '/access/users',
      '/access/organization',
    ]);
    expect(
      labels({
        'Access.manageRoles': true,
        'Access.manageOrganizationalUnits': true,
      }),
    ).toEqual(['/access/users', '/access/roles', '/access/organization']);
    // The API lets whoever impersonates list the users, to find whom.
    expect(labels({ 'Access.impersonate': true })).toEqual(['/access/users']);
    expect(labels({ 'Access.readAudit': true })).toEqual([]);
  });

  it('shows the members read-only to whoever only manages units', async () => {
    signedInWith({ 'Access.manageOrganizationalUnits': true });
    await renderApp('/access/users');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Bob Builder/ }),
    );
    const sheet = await screen.findByRole('dialog');
    expect(
      await within(sheet).findByText(/needs the permission to manage members/),
    ).toBeVisible();
    expect(
      within(sheet).getByRole('checkbox', { name: /Editor/ }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(
      within(sheet).queryByRole('button', { name: 'Save roles' }),
    ).toBeNull();
    expect(
      within(sheet).queryByRole('button', {
        name: 'Remove from this workspace',
      }),
    ).toBeNull();
    // No invitations (manageUsers only) and nobody to invite.
    expect(screen.queryByRole('heading', { name: 'Invitations' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
  });

  it('lets whoever manages users read the units, without changing the tree', async () => {
    signedInWith({ 'Access.manageUsers': true });
    await renderApp('/access/organization');
    expect(await screen.findByRole('link', { name: 'Sales' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New unit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it.each([
    ['/access/users', 'Access.manageRoles'],
    ['/access/roles', 'Access.manageUsers'],
    [`/access/roles/${ids.editor}`, 'Access.manageUsers'],
    ['/access/organization', 'Access.manageRoles'],
    ['/access/organization', 'Access.impersonate'],
  ])(
    'sends %s to the dashboard without its permission',
    async (path, other) => {
      signedInWith({ [other]: true });
      const { router } = await renderApp(path);
      await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    },
  );
});

describe('impersonation', () => {
  async function openBob() {
    const app = await renderApp('/access/users');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Bob Builder/ }),
    );
    return { ...app, user, sheet: await screen.findByRole('dialog') };
  }

  it('is hidden when the switch is off', async () => {
    signedInWith({ ...everything, 'Access.impersonate': true });
    const { sheet } = await openBob();
    await within(sheet).findByRole('button', { name: 'Save roles' });
    expect(
      within(sheet).queryByRole('button', { name: /Impersonate/ }),
    ).toBeNull();
  });

  it('is hidden without the permission', async () => {
    signedInWith(everything, { impersonation: true });
    const { sheet } = await openBob();
    await within(sheet).findByRole('button', { name: 'Save roles' });
    expect(
      within(sheet).queryByRole('button', { name: /Impersonate/ }),
    ).toBeNull();
  });

  it('is hidden for an administrator (the API refuses)', async () => {
    signedInWith(
      { ...everything, 'Access.impersonate': true },
      { impersonation: true },
    );
    await renderApp('/access/users');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Carol Admin/ }),
    );
    const sheet = await screen.findByRole('dialog');
    await within(sheet).findByRole('button', { name: 'Save roles' });
    expect(
      within(sheet).queryByRole('button', { name: /Impersonate/ }),
    ).toBeNull();
  });

  it('starts, resets the session and goes to the dashboard as the user, without a page load', async () => {
    signedInWith(
      { ...everything, 'Access.impersonate': true },
      { impersonation: true },
    );
    const started = capture('post', '/v1/access/users/:id/impersonate');
    const { user, sheet, queryClient, router } = await openBob();
    // The session is now Bob's, acted by Ada.
    const asBob = {
      ...signedInUser,
      user: {
        ...signedInUser.user,
        id: ids.bob,
        email: 'bob@example.com',
        name: 'Bob Builder',
        impersonator: { id: signedInUser.user.id, email: 'ada@example.com' },
      },
      can: { 'Note.read': true },
    };
    server.use(http.get('/v1/auth/me', () => HttpResponse.json(asBob)));
    await user.click(
      within(sheet).getByRole('button', { name: /Impersonate/ }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Impersonate',
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    // The mounted sidebar and banner changed in place: no page load.
    expect(
      await screen.findByRole('button', { name: /Bob Builder/ }),
    ).toBeVisible();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'ada@example.com',
    );
    expect(started).toHaveLength(1);
    expect(started[0]!.url).toMatch(`/v1/access/users/${ids.bob}/impersonate`);
    // `me` is the user's.
    expect(queryClient.getQueryData(['auth', 'me'])).toEqual(asBob);
  });
});
