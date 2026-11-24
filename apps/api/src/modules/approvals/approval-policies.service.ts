import { Transactional } from '@nestjs-cls/transactional';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import { assertUnchanged } from '../../core/http/etag.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { ApprovalEngine } from './approval-engine.service.js';
import { type ApprovalPolicy, parsePolicy } from './approval-policy.js';
import { ApprovalsRegistry } from './approvals.registry.js';
import { ApprovalPoliciesRepository } from './approval-policies.repository.js';

/** An action's policy in force: the code's default (version 0, or a reset) or an administrator's version. */
export interface EffectivePolicy {
  policy: ApprovalPolicy;
  version: number;
  source: 'code' | 'override';
}

/**
 * Policies in code with runtime versions. The code declares each action's
 * default; administrators store versions of their own, numbered per action
 * (`PUT /v1/approvals/policies/{key}`). The newest applies to new requests;
 * a request keeps the copy it started with. Read from the database every
 * time (one indexed row): nothing to keep in step across instances.
 */
@Injectable()
export class ApprovalPoliciesService {
  constructor(
    private readonly repository: ApprovalPoliciesRepository,
    private readonly registry: ApprovalsRegistry,
    private readonly audit: AuditService,
    private readonly engine: ApprovalEngine,
  ) {}

  /** The declared action, or a 404. */
  private declared(key: string) {
    const declared = this.registry.find(key);
    if (!declared) {
      throw new NotFoundException({
        code: 'not_found',
        message: this.engine.text('unknownAction', { key }),
      });
    }
    return declared;
  }

  /** The policy new requests of `key` get. */
  async effective(key: string): Promise<EffectivePolicy> {
    const latest = await this.repository.latest(key);
    return latest?.definition
      ? {
          policy: latest.definition,
          version: latest.version,
          source: 'override',
        }
      : {
          policy: this.declared(key).policy,
          version: latest?.version ?? 0,
          source: 'code',
        };
  }

  /** One action as GET /approvals/policies shows it. */
  async view(key: string) {
    const declared = this.declared(key);
    const effective = await this.effective(key);
    return {
      key,
      subject: declared.record.subject,
      action: declared.action,
      label: declared.approval.label,
      description: declared.approval.description ?? null,
      version: effective.version,
      source: effective.source,
      policy: effective.policy,
      default: declared.policy,
      flag: declared.flag?.key ?? null,
    };
  }

  async list() {
    const items = [];
    for (const { key } of this.registry.all()) items.push(await this.view(key));
    return { items };
  }

  /**
   * Stores a new version (validated), or with `null` goes back to the
   * code's default. Two administrators saving at once: the second is a 409
   * (the version is unique). Audited.
   */
  @Transactional()
  async set(
    by: Principal,
    key: string,
    input: unknown,
    ip?: string,
    /** The caller's If-Match: compared with the action as they would read it now. */
    ifMatch?: string,
  ) {
    const shown = await this.view(key);
    if (ifMatch) assertUnchanged(ifMatch, shown);
    const definition = input === null ? null : parsePolicy(input);
    const version = shown.version + 1;
    await this.repository
      .insert({ key, version, definition, changedBy: principalKey(by) })
      .catch((error: unknown) => {
        if (databaseErrorKind(error) === 'unique_violation') {
          throw new ConflictException({
            code: 'approval_policy_changed',
            message: this.engine.text('policyChanged'),
          });
        }
        throw error;
      });
    await this.audit.record(by, {
      action: definition ? 'approvalPolicy.updated' : 'approvalPolicy.reset',
      targetType: 'ApprovalPolicy',
      targetId: key,
      details: { version, ...(definition && { definition }) },
      ip,
    });
    return this.view(key);
  }
}
