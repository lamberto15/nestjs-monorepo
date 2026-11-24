import { Test } from '@nestjs/testing';
import { inAuditRun } from './audit-run.js';
import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';
import { signInEntries } from './audit.tables.js';
import { SIGN_IN_ACTIONS } from './sign-in-actions.js';
import { ClsModule } from 'nestjs-cls';
import type { UserPrincipal } from '../auth/principal.js';

/** AuditService's entries on a stubbed repository: no database. */
describe('AuditService', () => {
  const repository = { insert: vi.fn() };
  const user = { kind: 'user', id: 'user-1', email: 'ada@example.com' };
  let service: AuditService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true })],
      providers: [
        AuditService,
        { provide: AuditRepository, useValue: repository },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(AuditService);
  });

  it('writes an entry with nulls for what it lacks, in the run it is part of', async () => {
    await inAuditRun('run-1', () =>
      service.record(user as unknown as UserPrincipal, {
        action: 'note.deleted',
      }),
    );
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'note.deleted',
        targetType: null,
        details: null,
        runId: 'run-1',
      }),
      undefined,
    );
  });

  it('labels an anonymous attempt with what was typed', async () => {
    await service.recordAnonymous('who@example.com', { action: 'x' });
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'anonymous',
        actorLabel: 'who@example.com',
      }),
      undefined,
    );
  });

  it('names actors null when no module names them', async () => {
    await expect(
      service.withActorNames([{ actor: 'anonymous' }]),
    ).resolves.toEqual([{ actor: 'anonymous', actorName: null }]);
  });

  // The partial indexes' predicate is literals (audit.tables.ts): it must name both actions.
  it('keeps signInEntries in step with the sign-in actions', () => {
    const predicate = JSON.stringify(signInEntries.queryChunks);
    expect(predicate).toContain(SIGN_IN_ACTIONS.succeeded);
    expect(predicate).toContain(SIGN_IN_ACTIONS.failed);
  });
});
