import { hostname } from 'node:os';
import { CLI_PERMISSIONS, OPS_JOB } from './cli.jobs.js';
import { currentOperator } from './operator.js';

describe('the operator', () => {
  it('is the OS user and host of this process', () => {
    expect(currentOperator()).toEqual({
      user: expect.stringMatching(/\S/),
      host: hostname(),
    });
  });

  it('acts as the system job `ops`, which holds no permission', () => {
    expect(OPS_JOB.key).toBe('ops');
    expect(OPS_JOB.permissions).toEqual([]);
    expect(CLI_PERMISSIONS.systemJobs).toEqual([OPS_JOB]);
  });
});
