import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { z } from 'zod';
import type { RequestPrincipal } from '../../iam/auth/principal.js';

/**
 * A kind of record a schedule can create, declared by the module that owns
 * it in its own imports (`RecurrenceModule.forFeature()`):
 *
 * ```ts
 * RecurrenceModule.forFeature({
 *   name: 'notes',
 *   subject: 'Note',
 *   schema: createNoteSchema,
 *   create: (principal, row) => notes.create(principal, row),
 * })
 * ```
 *
 * `create` runs in the occurrence's transaction, as the schedule's owner
 * (looked up again at every occurrence), and throws to fail the attempt.
 */
export interface ScheduleTarget {
  /** Unique; what a schedule's `target` names: `notes`. */
  readonly name: string;
  /** The records' permission subject: `Note`. */
  readonly subject: string;
  /** What the owner must be allowed on the subject (default `create`). */
  readonly action?: string;
  /** What a template must look like: one row, as a create takes it. */
  readonly schema: z.ZodType;
  create(principal: RequestPrincipal, row: unknown): Promise<unknown>;
}

/**
 * One target, as `RecurrenceModule.forFeature()` provides it in the declaring
 * module; ScheduleTargets discovers every one. Serialized as its name: Nest
 * hashes a dynamic module's providers, and a target holds functions.
 */
export class ScheduleTargetRegistration {
  constructor(readonly target: ScheduleTarget) {}

  toJSON() {
    return `schedule-target#${this.target.name}`;
  }
}

/** The declared targets, found at startup; two with one name fail the start. */
@Injectable()
export class ScheduleTargets implements OnModuleInit {
  private readonly targets = new Map<string, ScheduleTarget>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders()) {
      if (!(wrapper.instance instanceof ScheduleTargetRegistration)) continue;
      const { target } = wrapper.instance;
      if (this.targets.get(target.name) === target) continue;
      if (this.targets.has(target.name)) {
        throw new Error(`Two schedule targets are named "${target.name}".`);
      }
      this.targets.set(target.name, target);
    }
  }

  find(name: string) {
    return this.targets.get(name);
  }
}
