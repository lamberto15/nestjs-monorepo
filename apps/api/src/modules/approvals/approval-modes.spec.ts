import { holds, stageOutcome, type StageVote } from './approval-modes.js';
import { conditionSchema, modeSchema, parsePolicy } from './approval-policy.js';

let clock = 0;
const vote = (status: StageVote['status'], decidedBy?: string): StageVote => {
  const approverId = `u${++clock}`;
  const decided = status !== 'pending' && status !== 'closed';
  return {
    approverId,
    status,
    decidedAt: decided ? new Date(clock * 1000) : null,
    decidedBy: decided ? (decidedBy ?? approverId) : null,
  };
};
const any = { type: 'any' } as const;
const all = { type: 'all' } as const;
const quorum = (n: number) => ({ type: 'quorum', n }) as const;

describe('stage modes', () => {
  it('any: the first decision decides, whatever it is', () => {
    expect(stageOutcome(any, [vote('pending'), vote('pending')])).toBe(
      'pending',
    );
    expect(stageOutcome(any, [vote('pending'), vote('rejected')])).toBe(
      'rejected',
    );
    const first = vote('approved');
    const second = vote('rejected');
    expect(stageOutcome(any, [second, first])).toBe('approved');
    // Everyone closed out (removed, deactivated): nobody can decide it.
    expect(stageOutcome(any, [vote('closed'), vote('closed')])).toBe(
      'unreachable',
    );
  });

  it('all: everyone approves; one rejection or request for changes decides at once', () => {
    expect(stageOutcome(all, [vote('approved'), vote('pending')])).toBe(
      'pending',
    );
    expect(stageOutcome(all, [vote('approved'), vote('approved')])).toBe(
      'approved',
    );
    expect(stageOutcome(all, [vote('approved'), vote('rejected')])).toBe(
      'rejected',
    );
    expect(
      stageOutcome(all, [vote('pending'), vote('changes_requested')]),
    ).toBe('changes_requested');
    // A closed-out approver counts for nothing, and nobody is no approval.
    expect(stageOutcome(all, [vote('approved'), vote('closed')])).toBe(
      'approved',
    );
    expect(stageOutcome(all, [])).toBe('unreachable');
    expect(stageOutcome(all, [vote('closed')])).toBe('unreachable');
  });

  it('quorum: n approvals; rejected once n is out of reach', () => {
    expect(
      stageOutcome(quorum(2), [
        vote('approved'),
        vote('pending'),
        vote('pending'),
      ]),
    ).toBe('pending');
    expect(
      stageOutcome(quorum(2), [
        vote('approved'),
        vote('rejected'),
        vote('approved'),
      ]),
    ).toBe('approved');
    expect(
      stageOutcome(quorum(2), [
        vote('rejected'),
        vote('pending'),
        vote('pending'),
      ]),
    ).toBe('pending');
    expect(
      stageOutcome(quorum(2), [
        vote('rejected'),
        vote('rejected'),
        vote('pending'),
      ]),
    ).toBe('rejected');
    // Never lowered: fewer approvers than n can't reach it.
    expect(stageOutcome(quorum(5), [vote('approved'), vote('approved')])).toBe(
      'unreachable',
    );
    expect(stageOutcome(quorum(3), [vote('pending'), vote('pending')])).toBe(
      'unreachable',
    );
    // Closing out who didn't answer (an escalation) doesn't lower it either.
    expect(
      stageOutcome(quorum(2), [
        vote('approved'),
        vote('closed'),
        vote('closed'),
      ]),
    ).toBe('unreachable');
    // One person counts once: their own assignment and the one they stood in for.
    expect(
      stageOutcome(quorum(2), [
        vote('approved', 'd'),
        vote('approved', 'd'),
        vote('pending'),
      ]),
    ).toBe('pending');
    expect(modeSchema.safeParse({ type: 'quorum', n: 0 }).success).toBe(false);
  });
});

describe('the payload condition', () => {
  const when = (
    condition: { path: string; op: string; value?: unknown },
    payload: Record<string, unknown>,
  ) => holds({ type: 'payload', ...condition } as never, payload);

  it('compares numbers, text and lists at a dotted path', () => {
    expect(
      when({ path: 'amount', op: 'gt', value: 1000 }, { amount: 1200 }),
    ).toBe(true);
    expect(
      when({ path: 'amount', op: 'gt', value: 1000 }, { amount: 1000 }),
    ).toBe(false);
    expect(
      when({ path: 'amount', op: 'lte', value: 1000 }, { amount: 1000 }),
    ).toBe(true);
    expect(
      when(
        { path: 'lines.0.total', op: 'gte', value: 5 },
        { lines: [{ total: 5 }] },
      ),
    ).toBe(true);
    expect(
      when(
        { path: 'due', op: 'lt', value: '2026-12-01' },
        { due: '2026-11-30' },
      ),
    ).toBe(true);
    expect(
      when({ path: 'kind', op: 'in', value: ['a', 'b'] }, { kind: 'b' }),
    ).toBe(true);
    expect(
      when({ path: 'kind', op: 'notIn', value: ['a', 'b'] }, { kind: 'b' }),
    ).toBe(false);
    expect(when({ path: 'note', op: 'exists' }, {})).toBe(false);
    // A number compared with text is never true.
    expect(
      when({ path: 'amount', op: 'gt', value: 10 }, { amount: '20' }),
    ).toBe(false);
  });

  it('combines with all, any and not', () => {
    const big = {
      type: 'payload',
      path: 'amount',
      op: 'gt',
      value: 100,
    } as const;
    const red = {
      type: 'payload',
      path: 'kind',
      op: 'eq',
      value: 'red',
    } as const;
    const payload = { amount: 200, kind: 'blue' };
    expect(holds({ type: 'all', conditions: [big, red] }, payload)).toBe(false);
    expect(holds({ type: 'any', conditions: [big, red] }, payload)).toBe(true);
    expect(holds({ type: 'not', condition: red }, payload)).toBe(true);
    expect(holds(null, payload)).toBe(true);
  });

  it('checks its parameters', () => {
    const parse = (c: object) =>
      conditionSchema.safeParse({ type: 'payload', ...c }).success;
    expect(parse({ path: 'a', op: 'gt' })).toBe(false);
    expect(parse({ path: 'a', op: 'in', value: 1 })).toBe(false);
    expect(parse({ path: 'a', op: 'exists' })).toBe(true);
  });
});

describe('parsePolicy', () => {
  const stage = {
    name: 'Review',
    approvers: [{ type: 'role', role: 'editor' }],
  };

  it('fills in the defaults', () => {
    expect(parsePolicy({ stages: [stage] })).toMatchObject({
      enabled: true,
      resubmitWithin: '30d',
      stages: [{ name: 'Review', mode: { type: 'any' }, onOverdue: 'expire' }],
    });
  });

  it('names each wrong path', () => {
    const paths = (input: unknown) => {
      try {
        parsePolicy(input);
        return [];
      } catch (error) {
        const body = (
          error as { getResponse(): { errors: { path: string }[] } }
        ).getResponse();
        return body.errors.map((e) => e.path);
      }
    };
    expect(
      paths({
        stages: [
          { ...stage, approvers: [stage.approvers[0], { type: 'role' }] },
        ],
      }),
    ).toEqual(['stages.0.approvers.1.role']);
    expect(paths({ stages: [{ ...stage, onOverdue: 'escalate' }] })).toEqual([
      'stages.0.escalateTo',
      'stages.0.dueAfter',
    ]);
    expect(
      paths({ stages: [{ ...stage, remindAfter: '2d', dueAfter: '1d' }] }),
    ).toEqual(['stages.0.remindAfter']);
    let deep: object = { type: 'payload', path: 'a', op: 'exists' };
    for (let i = 0; i < 5; i++) deep = { type: 'not', condition: deep };
    expect(paths({ stages: [stage], when: deep })).toEqual(['when']);
  });
});
