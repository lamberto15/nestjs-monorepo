import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { Principal } from '../../iam/auth/principal.js';
import type { RecordDeclaration } from '../records/record.js';
import { flag, type SettingDeclaration } from '../settings/settings.types.js';
import {
  type ApprovalPolicy,
  type ApprovalPolicyInput,
  parsePolicy,
} from './approval-policy.js';

/**
 * An action of a record that needs approval, as the feature declares it in
 * `ApprovalsModule.forRecord(INVOICE, { publish: { label: 'Publish an invoice' } })`.
 */
export interface RecordApproval {
  /** The action in the inbox and on its route: "Publish an invoice". */
  label: string;
  description?: string;
  /**
   * The default policy (administrators may store their own at runtime).
   * Default: one stage, "Review", decided by any user who may update the
   * record, but not the requester.
   */
  policy?: ApprovalPolicyInput;
  /**
   * `true` (the default): off until its flag, `<path>.<action>Approval`,
   * is switched on for the tenant or a unit (`/v1/settings`); the action
   * then runs at once. `false`: always needs approval.
   */
  flag?: boolean;
}

/** What the feature's effect is told when an action is applied. */
export interface ApprovalApplied {
  /** The record. */
  id: string;
  /**
   * Who applies it: the requester when no approval was needed, the
   * workflow's system principal (`system:approvals`) once approved.
   */
  actor: Principal;
}

/**
 * What happens once an action is applied: the feature's provider marked
 * `@ApprovalEffect({ subject: 'Invoice', action: 'publish' })`. It runs at once when no approval
 * is needed, and as a workflow step once approved: at least once, so make
 * it idempotent. Its writes to the record skip the record's open requests.
 */
export interface ApprovalEffectHandler {
  apply(applied: ApprovalApplied): Promise<void>;
}

/** Marks the provider that applies an approvable action: `@ApprovalEffect({ subject: 'Invoice', action: 'publish' })`. */
export const ApprovalEffect = DiscoveryService.createDecorator<{
  subject: string;
  action: string;
}>();

/** The action's word in the route: `markPaid` → `mark-paid`. */
export const actionPath = (action: string) =>
  action.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

const ACTION = /^[a-z][a-zA-Z0-9]*$/;

const DEFAULT_POLICY: ApprovalPolicyInput = {
  stages: [
    {
      name: 'Review',
      approvers: [{ type: 'permission', action: 'update' }],
      mode: { type: 'any' },
    },
  ],
};

/** One approvable action of a record, built once by `forRecord()`. */
export interface DeclaredAction {
  /** `Invoice.publish`. */
  key: string;
  record: RecordDeclaration;
  action: string;
  approval: RecordApproval;
  policy: ApprovalPolicy;
  /** The flag that switches it on, unless `flag: false`. */
  flag: SettingDeclaration<boolean> | null;
}

/** The actions one `ApprovalsModule.forRecord()` declares: a provider ApprovalsRegistry finds. */
export class ApprovalRegistration {
  readonly actions: DeclaredAction[];

  constructor(
    record: RecordDeclaration,
    actions: Record<string, RecordApproval>,
  ) {
    const camel = record.path.replace(/-([a-z])/g, (_m, c: string) =>
      c.toUpperCase(),
    );
    this.actions = Object.entries(actions).map(([action, approval]) => {
      if (!ACTION.test(action)) {
        throw new Error(
          `${record.subject}: "${action}" can't be an approval's action: a word like publish or markPaid.`,
        );
      }
      return {
        key: `${record.subject}.${action}`,
        record,
        action,
        approval,
        policy: parsePolicy(approval.policy ?? DEFAULT_POLICY),
        flag:
          approval.flag === false
            ? null
            : flag({
                // Never per user: a requester could switch their own approval off.
                scopes: ['tenant', 'unit'],
                key: `${camel}.${action}Approval`,
                label: `${approval.label}: needs approval`,
                description: `When on, ${action} runs only once it is approved (GET /v1/approvals).`,
                default: false,
              }),
      };
    });
  }

  /** Nest hashes a dynamic module's metadata: name it. */
  toJSON() {
    return `approvals:${this.actions.map((a) => a.key).join(',')}`;
  }
}

/** While an approved (or immediate) effect runs: its writes skip the record's open requests. */
const APPLYING = new AsyncLocalStorage<true>();

export const applyingEffect = () => APPLYING.getStore() === true;

/**
 * Every approvable action of the app and its effect, found at startup
 * (DiscoveryService): the registrations `forRecord()` provides and the
 * features' `@ApprovalEffect()` providers. An action without exactly one
 * effect stops the start.
 */
@Injectable()
export class ApprovalsRegistry implements OnModuleInit {
  private readonly actions = new Map<
    string,
    DeclaredAction & { effect: ApprovalEffectHandler }
  >();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    const effects = new Map<string, ApprovalEffectHandler>();
    for (const wrapper of this.discovery.getProviders({
      metadataKey: ApprovalEffect.KEY,
    })) {
      const target = this.discovery.getMetadataByDecorator(
        ApprovalEffect,
        wrapper,
      );
      if (!target || !wrapper.instance) continue;
      const key = `${target.subject}.${target.action}`;
      if (effects.has(key) && effects.get(key) !== wrapper.instance) {
        throw new Error(`Approvals: "${key}" has two effects.`);
      }
      effects.set(key, wrapper.instance as ApprovalEffectHandler);
    }
    for (const wrapper of this.discovery.getProviders()) {
      const found: unknown = wrapper.instance;
      if (!(found instanceof ApprovalRegistration)) continue;
      for (const declared of found.actions) {
        const effect = effects.get(declared.key);
        if (!effect) {
          throw new Error(
            `Approvals: "${declared.key}" needs approval but has no effect: a provider of its feature marked @ApprovalEffect({ subject: '${declared.record.subject}', action: '${declared.action}' }).`,
          );
        }
        const existing = this.actions.get(declared.key);
        if (existing && existing.record !== declared.record) {
          throw new Error(`Approvals: "${declared.key}" is declared twice.`);
        }
        this.actions.set(declared.key, { ...declared, effect });
        effects.delete(declared.key);
      }
    }
    const orphan = [...effects.keys()].find((key) => !this.actions.has(key));
    if (orphan) {
      throw new Error(
        `Approvals: "${orphan}" has an effect but no ApprovalsModule.forRecord() declares it.`,
      );
    }
  }

  /** Whether any action of `subject` needs approval. */
  declares(subject: string) {
    return [...this.actions.values()].some((a) => a.record.subject === subject);
  }

  /** The declared actions. */
  all() {
    return [...this.actions.values()];
  }

  find(key: string) {
    return this.actions.get(key);
  }

  /** A declared action: an undeclared one is a programming mistake. */
  action(key: string) {
    const found = this.actions.get(key);
    if (!found)
      throw new Error(`Approvals: "${key}" is not an approvable action.`);
    return found;
  }

  /** Runs an action's effect: its writes don't wait for the record's open requests. */
  apply(key: string, applied: ApprovalApplied) {
    const { effect } = this.action(key);
    return APPLYING.run(true, () => effect.apply(applied));
  }
}
