import { Injectable, Module } from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { accessModules, tenantWithAdmin } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Principal } from '../../iam/auth/principal.js';
import { InboxModule } from './inbox.module.js';
import { InboxSourceOf, type InboxSource } from './inbox.source.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
});

const dismissed: string[] = [];

/** A module's source: what waits on whoever calls, from its own state. */
@InboxSourceOf('mention')
@Injectable()
class MentionSource implements InboxSource {
  items(_: Principal, { limit, after }: { limit: number; after?: string }) {
    const ids = [
      '0199a3f2-0000-7000-8000-00000000000b',
      '0199a3f2-0000-7000-8000-000000000003',
    ];
    return Promise.resolve(
      ids
        .filter((id) => !after || id < after)
        .slice(0, limit)
        .map((id) => ({
          id,
          at: new Date('2026-01-01T00:00:00Z'),
          kind: 'mention',
          data: { by: 'Ada' },
          link: '/notes/1',
          dueAt: null,
        })),
    );
  }

  dismiss(_: Principal, id: string) {
    dismissed.push(id);
    return Promise.resolve();
  }
}

@InboxSourceOf('approval')
@Injectable()
class ApprovalSource implements InboxSource {
  items(_: Principal, { after }: { limit: number; after?: string }) {
    const id = '0199a3f2-0000-7000-8000-00000000000a';
    if (after && id >= after) return Promise.resolve([]);
    return Promise.resolve([
      {
        id,
        at: new Date('2026-01-02T00:00:00Z'),
        kind: 'approval.decide',
        data: {},
        link: null,
        dueAt: new Date('2026-02-01T00:00:00Z'),
      },
    ]);
  }
}

@Module({ providers: [MentionSource, ApprovalSource] })
class SourcesModule {}

describe('inbox (e2e)', () => {
  let app: NestNodeApplication;
  let headers: Record<string, string>;

  beforeAll(async () => {
    app = await bootModules(...accessModules(), InboxModule, SourcesModule);
    headers = (await tenantWithAdmin(app)).admin.headers;
  });
  afterAll(() => app.close());

  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers, ...(payload && { payload }) });

  it('merges the sources newest first, and pages with a cursor', async () => {
    const first = (await call('GET', '/v1/inbox?limit=2')).json();
    expect(first.items.map((item: { key: string }) => item.key)).toEqual([
      'mention:0199a3f2-0000-7000-8000-00000000000b',
      'approval:0199a3f2-0000-7000-8000-00000000000a',
    ]);
    expect(first.items[1]).toMatchObject({
      kind: 'approval.decide',
      canDismiss: false,
      dueAt: '2026-02-01T00:00:00.000Z',
    });
    const second = (
      await call('GET', `/v1/inbox?limit=2&cursor=${first.nextCursor}`)
    ).json();
    expect(second.items.map((item: { key: string }) => item.key)).toEqual([
      'mention:0199a3f2-0000-7000-8000-000000000003',
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('narrows to one source, and says when there is none', async () => {
    expect(
      (await call('GET', '/v1/inbox?source=approval')).json().items,
    ).toHaveLength(1);
    expect((await call('GET', '/v1/inbox?source=nope')).statusCode).toBe(404);
    expect((await call('GET', '/v1/inbox?cursor=!!')).statusCode).toBe(400);
  });

  it('dismisses what its source lets be dismissed', async () => {
    const key = 'mention:0199a3f2-0000-7000-8000-00000000000b';
    expect((await call('POST', '/v1/inbox/dismiss', { key })).statusCode).toBe(
      204,
    );
    expect(dismissed).toEqual(['0199a3f2-0000-7000-8000-00000000000b']);
    expect(
      (
        await call('POST', '/v1/inbox/dismiss', {
          key: 'approval:0199a3f2-0000-7000-8000-00000000000a',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call('POST', '/v1/inbox/dismiss', { key: 'nowhere:1' }))
        .statusCode,
    ).toBe(404);
  });
});
