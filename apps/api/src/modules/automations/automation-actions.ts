import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { z } from 'zod';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import type { RecordRow } from '../records/record.js';
import type { RecordRegistration } from '../records/records.service.js';

/** A problem with an action's definition: `path` under the action (`field`, `value`). */
export interface ActionProblem {
  path: string;
  message: string;
}

/** What an action is asked to plan: the record, as the rule's owner, with its parameters. */
export interface ActionContext<P> {
  record: RecordRegistration;
  /** Who the rule runs as (its owner, or who simulates it): every check is theirs. */
  principal: UserPrincipal;
  row: RecordRow;
  params: P;
  /** The rule, or `{ id: null, name: '' }` in a simulation. */
  rule: { id: string | null; name: string };
}

/** One action, checked: what it would do and, when allowed, how. */
export interface PlannedAction {
  allowed: boolean;
  /** Why not: `forbidden`, `field_forbidden`, `no_recipient`… */
  reason?: string;
  /** What it does, for people: `title = "Urgent"`, `2 of 3`. */
  detail: string;
  /** Does it, in the run's transaction (a rule's writes trigger no rule). Never called by a simulation. */
  apply?: () => Promise<void>;
}

/**
 * An action rules may take: `@AutomationAction('setField')` on a provider
 * implementing this, in any module (one that automations may not import,
 * such as approvals, declares its own). Every check runs as the rule's
 * owner, as they are at each run.
 */
export interface AutomationActionHandler<P extends object = object> {
  /** Its parameters, besides `type` (a Zod object: unknown keys are dropped). */
  readonly params: z.ZodType<P>;
  /** Whether a subject takes it at all (default: every one). */
  supports?(record: RecordRegistration): boolean;
  /** Checks of a definition against the subject, when a rule is saved. */
  check?(
    record: RecordRegistration,
    params: P,
  ): Promise<ActionProblem[]> | ActionProblem[];
  /** What GET /automation-rules/subjects says of it for the subject (`fields` it may set). */
  describe?(record: RecordRegistration): Record<string, unknown>;
  plan(context: ActionContext<P>): Promise<PlannedAction>;
}

/** Marks a provider as the action of this name (lowercase camelCase: `setField`). */
export const AutomationAction = DiscoveryService.createDecorator<string>();

const NAME = /^[a-z][A-Za-z0-9]*$/;

/** Every action a provider declared (`@AutomationAction()`), found at startup: no list to edit. */
@Injectable()
export class AutomationActions implements OnModuleInit {
  private readonly actions = new Map<string, AutomationActionHandler>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders({
      metadataKey: AutomationAction.KEY,
    })) {
      const name = this.discovery.getMetadataByDecorator(
        AutomationAction,
        wrapper,
      );
      const handler = wrapper.instance as AutomationActionHandler | undefined;
      if (!name || !handler) continue;
      if (!NAME.test(name)) {
        throw new Error(
          `"${name}" is no automation action name: camelCase, as setField.`,
        );
      }
      if (this.actions.has(name) && this.actions.get(name) !== handler) {
        throw new Error(
          `Two providers declare the automation action "${name}".`,
        );
      }
      this.actions.set(name, handler);
    }
  }

  find(name: string): AutomationActionHandler | undefined {
    return this.actions.get(name);
  }

  /** The actions a subject takes, by name. */
  of(record: RecordRegistration) {
    return [...this.actions]
      .filter(([, handler]) => handler.supports?.(record) ?? true)
      .sort(([a], [b]) => a.localeCompare(b));
  }
}
