import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeProvider } from '@/lib/realtime';
import { createFakeRealtime, type FakeRealtime } from '@/test/fake-realtime';
import { TEST_RECORD, usePanelsApi } from '@/test/panels-api';
import { renderComponent } from '@/test/render-component';
import { allFeatures, problem, server, signedInUser } from '@/test/server';
import { RecordPanels } from './record-panels';

const connections: FakeRealtime[] = [];
vi.mock('@nestjs-monorepo/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nestjs-monorepo/api-client')>()),
  createRealtime: vi.fn(() => {
    const fake = createFakeRealtime();
    connections.push(fake);
    return fake;
  }),
}));

beforeEach(() => {
  connections.length = 0;
});

const ID = '0199a3f2-0000-7000-8000-000000000601';
const DOC = '0199a3f2-0000-7000-8000-000000000701';
const CAN = ['TestItem.read', 'TestItem.update'];

/** One document of the record, as `GET …/{id}/documents` lists it. */
const doc = (state: object = {}) => ({
  id: DOC,
  status: 'completed',
  template: 'pdf-record',
  language: 'en',
  issuedBy: `user:${signedInUser.user.id}`,
  issuedByName: 'Ada',
  createdAt: '2026-10-17T09:00:00.000Z',
  finishedAt: '2026-10-17T09:01:00.000Z',
  error: null,
  errorCode: null,
  ...state,
});

/**
 * The documents routes: what POST /pdf answers, and the record's documents
 * list in turn (the last one stays).
 */
function useDocumentsApi(
  options: { issue?: () => Response; lists?: object[][] } = {},
) {
  const issued: { id: string; lang: string | null; key: string | null }[] = [];
  const lists = [...(options.lists ?? [[]])];
  server.use(
    http.post('/v1/test-items/:id/pdf', ({ params, request }) => {
      issued.push({
        id: params.id as string,
        lang: new URL(request.url).searchParams.get('lang'),
        key: request.headers.get('idempotency-key'),
      });
      return (
        options.issue?.() ??
        HttpResponse.json({ id: DOC, status: 'queued' }, { status: 202 })
      );
    }),
    http.get('/v1/test-items/:id/documents', () =>
      HttpResponse.json({
        items: lists.length > 1 ? lists.shift()! : lists[0]!,
        nextCursor: null,
      }),
    ),
  );
  return issued;
}

async function mount(can = CAN) {
  return renderComponent(
    <RealtimeProvider>
      <RecordPanels
        subject={TEST_RECORD.subject}
        path={TEST_RECORD.path}
        id={ID}
      />
    </RealtimeProvider>,
    { can },
  );
}

async function openTab() {
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole('tab', { name: 'Documents' }));
  return user;
}

describe('documents panel', () => {
  it('lists the record’s documents from its documents route, with a download for an issued one', async () => {
    usePanelsApi({ capabilities: { pdf: true } });
    useDocumentsApi({
      lists: [
        [doc(), doc({ id: 'other', issuedBy: 'user:x', language: 'ar' })],
      ],
    });
    await mount();
    await openTab();
    const link = await screen.findByRole('link', {
      name: 'Download PDF in English',
    });
    expect(link).toHaveAttribute('href', `/v1/documents/${DOC}/download`);
    expect(screen.getByText('By you')).toBeInTheDocument();
    // Someone else's, by the name the tenant knows them by.
    expect(screen.getByText('Ada')).toBeInTheDocument();
  });

  it('issues a document in the chosen language, shows it running, then issued', async () => {
    usePanelsApi({ capabilities: { pdf: true } });
    server.use(
      // Two languages: with one there is nothing to choose and no field.
      http.get('/v1/features', () =>
        HttpResponse.json({ ...allFeatures, locales: ['en', 'ar'] }),
      ),
    );
    const issued = useDocumentsApi({
      lists: [
        [],
        [doc({ status: 'queued', language: 'ar', finishedAt: null })],
        [doc({ language: 'ar' })],
      ],
    });
    await mount();
    const user = await openTab();
    expect(await screen.findByText('No documents issued yet.')).toBeVisible();

    // Arabic is written right to left by the API: the panel only passes it.
    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(await screen.findByRole('option', { name: 'العربية' }));
    await user.click(screen.getByRole('button', { name: 'Issue PDF' }));

    expect(await screen.findByText('Waiting to be made…')).toBeVisible();
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ id: ID, lang: 'ar' });
    expect(issued[0]!.key).toBeTruthy();

    // The worker is done: the socket says so, and the list is read again.
    await waitFor(() => expect(connections).toHaveLength(1));
    act(() =>
      connections[0]!.emit('document.ready', {
        id: DOC,
        subject: 'TestItem',
        recordId: ID,
        attachmentId: 'att-1',
      }),
    );
    expect(
      await screen.findByRole('link', { name: 'Download PDF in العربية' }),
    ).toBeVisible();
    expect(screen.queryByText('Waiting to be made…')).not.toBeInTheDocument();
  });

  it('polls while one runs when there is no socket', async () => {
    server.use(
      http.get('/v1/features', () =>
        HttpResponse.json({ ...allFeatures, realtime: false }),
      ),
    );
    usePanelsApi({ capabilities: { pdf: true } });
    useDocumentsApi({
      lists: [[doc({ status: 'rendering', finishedAt: null })], [doc()]],
    });
    await mount();
    await openTab();
    expect(await screen.findByText('Making the PDF…')).toBeVisible();
    await waitFor(
      () =>
        expect(screen.queryByText('Making the PDF…')).not.toBeInTheDocument(),
      { timeout: 4000 },
    );
  }, 8000);

  it('sends the UI language by default', async () => {
    usePanelsApi({ capabilities: { pdf: true } });
    const issued = useDocumentsApi();
    await mount();
    const user = await openTab();
    await user.click(await screen.findByRole('button', { name: 'Issue PDF' }));
    await waitFor(() => expect(issued[0]?.lang).toBe('en'));
  });

  it('shows why a document failed, with no download', async () => {
    usePanelsApi({ capabilities: { pdf: true } });
    useDocumentsApi({
      lists: [
        [doc({ status: 'failed', error: 'The PDF service refused the page.' })],
      ],
    });
    await mount();
    await openTab();
    expect(
      await screen.findByText('The PDF service refused the page.'),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
  });

  it('on 503 documents_unavailable says so and hides the issue button', async () => {
    usePanelsApi({ capabilities: { pdf: true } });
    useDocumentsApi({
      issue: () => problem(503, 'documents_unavailable'),
      lists: [[doc()]],
    });
    await mount();
    const user = await openTab();
    await user.click(await screen.findByRole('button', { name: 'Issue PDF' }));
    expect(
      await screen.findByText(/PDF documents are not available right now/),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Issue PDF' }),
    ).not.toBeInTheDocument();
    // What was issued before stays downloadable.
    expect(
      screen.getByRole('link', { name: 'Download PDF in English' }),
    ).toBeVisible();
  });

  it('shows the document already being made on 409 document_pending', async () => {
    usePanelsApi({ capabilities: { pdf: true } });
    useDocumentsApi({
      issue: () => problem(409, 'document_pending', { id: DOC }),
      lists: [[], [doc({ status: 'rendering', finishedAt: null })]],
    });
    await mount();
    const user = await openTab();
    await user.click(await screen.findByRole('button', { name: 'Issue PDF' }));
    expect(await screen.findByText('Making the PDF…')).toBeVisible();
  });
});

describe('documents panel gating', () => {
  it('has no tab when the subject takes no PDF', async () => {
    usePanelsApi({ capabilities: { pdf: false } });
    await mount();
    // The tabs of the other panels: the subject's description has arrived.
    await screen.findByRole('tablist');
    expect(
      screen.queryByRole('tab', { name: 'Documents' }),
    ).not.toBeInTheDocument();
  });

  it('has no tab when the documents feature is off', async () => {
    server.use(
      http.get('/v1/features', () =>
        HttpResponse.json({ ...allFeatures, documents: false }),
      ),
    );
    usePanelsApi({ capabilities: { pdf: true } });
    await mount();
    // The tabs of the other panels: the subject's description has arrived.
    await screen.findByRole('tablist');
    expect(
      screen.queryByRole('tab', { name: 'Documents' }),
    ).not.toBeInTheDocument();
  });
});
