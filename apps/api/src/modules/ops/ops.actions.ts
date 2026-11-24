import { Injectable } from '@nestjs/common';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { OpsBacklog } from './ops.backlog.js';
import { OpsDiagnostics } from './ops.diagnostics.js';
import type { BacklogAction, DeadLettersTarget } from './ops.schemas.js';
import { OpsService } from './ops.service.js';

/**
 * What an operator changes through the routes, each audited in the
 * operators' tenant. Apart from OpsService and OpsBacklog because the
 * command line runs the same work and audits it its own way.
 */
@Injectable()
export class OpsActions {
  constructor(
    private readonly ops: OpsService,
    private readonly backlog: OpsBacklog,
    private readonly diagnostics: OpsDiagnostics,
    private readonly audit: AuditService,
  ) {}

  async pause(user: UserPrincipal, name: string, ip?: string) {
    const result = await this.ops.pause(name);
    await this.audit.record(user, {
      action: 'ops.queue-paused',
      targetType: 'queue',
      targetId: name,
      ip,
    });
    return result;
  }

  async resume(user: UserPrincipal, name: string, ip?: string) {
    const result = await this.ops.resume(name);
    await this.audit.record(user, {
      action: 'ops.queue-resumed',
      targetType: 'queue',
      targetId: name,
      ip,
    });
    return result;
  }

  async retryFailed(user: UserPrincipal, name: string, ip?: string) {
    const retried = await this.ops.retryFailed(name);
    await this.audit.record(user, {
      action: 'ops.queue-failed-retried',
      targetType: 'queue',
      targetId: name,
      details: { retried },
      ip,
    });
    return { retried };
  }

  async retryDeadLetters(
    user: UserPrincipal,
    target: DeadLettersTarget,
    ip?: string,
  ) {
    const retried = await this.ops.retryDeadLetters(target);
    await this.audit.record(user, {
      action: 'ops.dead-letters-retried',
      details: { ids: target.ids ?? 'all', retried },
      ip,
    });
    return { retried };
  }

  async discardDeadLetters(
    user: UserPrincipal,
    target: DeadLettersTarget,
    ip?: string,
  ) {
    const discarded = await this.ops.discardDeadLetters(target);
    await this.audit.record(user, {
      action: 'ops.dead-letters-discarded',
      details: { ids: target.ids ?? 'all', discarded },
      ip,
    });
    return { discarded };
  }

  async testDiagnostic(user: UserPrincipal, check: string, ip?: string) {
    const result = await this.diagnostics.test(check);
    await this.audit.record(user, {
      action: 'ops.diagnostic-tested',
      targetType: 'integration',
      targetId: check,
      details: { ok: result.ok, durationMs: result.durationMs },
      ip,
    });
    return result;
  }

  async discardBacklog(user: UserPrincipal, body: BacklogAction, ip?: string) {
    const result = await this.backlog.discard(
      body.target,
      body.scope,
      body.limit,
    );
    await this.audit.record(user, {
      action: 'ops.backlog-discarded',
      targetType: body.target,
      details: { scope: body.scope, ...result },
      ip,
    });
    return result;
  }

  async retryBacklog(user: UserPrincipal, body: BacklogAction, ip?: string) {
    const result = await this.backlog.retry(
      body.target,
      body.scope,
      body.limit,
    );
    await this.audit.record(user, {
      action: 'ops.backlog-retried',
      targetType: body.target,
      details: { scope: body.scope, ...result },
      ip,
    });
    return result;
  }

  async retryWorkflow(user: UserPrincipal, id: string, ip?: string) {
    const result = await this.ops.retryWorkflow(id);
    await this.audit.record(user, {
      action: 'ops.workflow-retried',
      targetType: 'workflow',
      targetId: id,
      ip,
    });
    return result;
  }
}
