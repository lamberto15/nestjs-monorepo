import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { t } from '@nestjs/i18n';
import { MailTransport, SmtpTransport } from '@nestjs/mail';
import { ResilienceTimeoutError, TimeoutPolicy } from '@nestjs/resilience';
import { logRedaction } from '../../core/logging/redaction.js';
import {
  ReadinessCheck,
  type ReadinessIndicator,
} from '../../core/health/readiness.js';
import { OpsService } from './ops.service.js';

/**
 * Marks a provider as an integration the operators can look at and test
 * (`GET /v1/ops/diagnostics`), under the given name: the module that owns
 * the integration says how to ask it. Like `@ReadinessCheck()`, which every
 * diagnostic also includes (the database, Redis), but for what must not
 * make `GET /health` fail: mail and storage being down is for an operator
 * to see, not a reason to take the instance out of rotation.
 *
 * `onDemand`: the check does something (a connection, a probe file), so
 * the overview does not run it: it shows `configured` until the test route
 * is called. The provider implements `DiagnosticProbe`.
 */
export const Diagnostic = DiscoveryService.createDecorator<{
  name: string;
  onDemand?: boolean;
}>();

export interface DiagnosticProbe {
  /** The driver or transport in use (`smtp`, `s3`): a name, never a URL or a credential. */
  readonly driver?: string;
  /** False when this configuration has nothing safe to probe. Default true. */
  readonly testable?: boolean;
  /** Resolves when the integration answers; throws when it doesn't. */
  check(): Promise<void>;
}

export interface DiagnosticState {
  name: string;
  /** ok: answered now; configured: set up, not probed (run its test); unavailable: did not answer. */
  state: 'ok' | 'configured' | 'unavailable';
  driver: string | null;
  /** What went wrong, masked as in the logs and cut; null when nothing did. */
  detail: string | null;
  testable: boolean;
}

export interface DiagnosticTest {
  name: string;
  ok: boolean;
  durationMs: number;
  detail: string | null;
}

/** How long one probe may take. */
const PROBE_MS = 5000;
const probeTimeout = new TimeoutPolicy({
  timeout: PROBE_MS,
  name: 'ops-diagnostic',
});

const describe = (error: unknown) =>
  logRedaction
    .redactText(error instanceof Error ? error.message : String(error))
    .slice(0, 300);

interface Entry {
  name: string;
  onDemand: boolean;
  probe: DiagnosticProbe;
}

/** The workers: at least one connected to a queue. */
@Diagnostic({ name: 'workers' })
@Injectable()
export class WorkersDiagnostic implements DiagnosticProbe {
  readonly driver = 'bullmq';
  constructor(private readonly ops: OpsService) {}

  async check() {
    const queues = await this.ops.queueStates();
    if (!queues.some((queue) => queue.workers > 0)) {
      throw new Error('No worker is connected to any queue.');
    }
  }
}

/** Mail: SMTP connects, authenticates and says QUIT; no message is sent. The HTTP providers have no such check. */
@Diagnostic({ name: 'mail', onDemand: true })
@Injectable()
export class MailDiagnostic implements DiagnosticProbe {
  constructor(@Optional() private readonly transport?: MailTransport) {}

  get driver() {
    return this.transport?.constructor.name
      .replace(/Transport$/, '')
      .toLowerCase();
  }

  get testable() {
    return this.transport instanceof SmtpTransport;
  }

  async check() {
    if (!(this.transport instanceof SmtpTransport)) {
      throw new Error('This mail transport has no check that sends nothing.');
    }
    await this.transport.verify();
  }
}

/** What the operators see of the integrations, and the safe test of each. */
@Injectable()
export class OpsDiagnostics {
  constructor(private readonly discovery: DiscoveryService) {}

  /** The diagnostics and the readiness checks of this app, by name. */
  private entries(): Entry[] {
    const found = new Map<string, Entry>();
    for (const wrapper of this.discovery.getProviders({
      metadataKey: ReadinessCheck.KEY,
    })) {
      const name = this.discovery.getMetadataByDecorator(
        ReadinessCheck,
        wrapper,
      )!;
      const indicator = wrapper.instance as ReadinessIndicator;
      found.set(name, {
        name,
        onDemand: false,
        probe: { driver: name, check: () => indicator.check() },
      });
    }
    for (const wrapper of this.discovery.getProviders({
      metadataKey: Diagnostic.KEY,
    })) {
      const { name, onDemand } = this.discovery.getMetadataByDecorator(
        Diagnostic,
        wrapper,
      )!;
      found.set(name, {
        name,
        onDemand: onDemand ?? false,
        probe: wrapper.instance as DiagnosticProbe,
      });
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async run(probe: DiagnosticProbe) {
    try {
      await probeTimeout.execute(() => probe.check());
    } catch (error) {
      throw error instanceof ResilienceTimeoutError
        ? new Error(`No answer within ${PROBE_MS / 1000} s.`)
        : error;
    }
  }

  /** Every integration's state: the cheap checks run, the on-demand ones are only read as set up. */
  async overview(): Promise<DiagnosticState[]> {
    return Promise.all(
      this.entries().map(async ({ name, onDemand, probe }) => {
        const base = {
          name,
          driver: probe.driver ?? null,
          testable: probe.testable ?? true,
        };
        if (onDemand)
          return { ...base, state: 'configured' as const, detail: null };
        try {
          await this.run(probe);
          return { ...base, state: 'ok' as const, detail: null };
        } catch (error) {
          return {
            ...base,
            state: 'unavailable' as const,
            detail: describe(error),
          };
        }
      }),
    );
  }

  /** Probes one integration now. A failed probe is `ok: false` with the masked reason, never an error. */
  async test(name: string): Promise<DiagnosticTest> {
    const entry = this.entries().find((candidate) => candidate.name === name);
    if (!entry) {
      throw new NotFoundException({
        code: 'diagnostic_not_found',
        message: t('ops.diagnosticNotFound', { args: { name } }),
      });
    }
    if (entry.probe.testable === false) {
      throw new BadRequestException({
        code: 'not_testable',
        message: t('ops.notTestable', { args: { name } }),
      });
    }
    const started = performance.now();
    let detail: string | null = null;
    try {
      await this.run(entry.probe);
    } catch (error) {
      detail = describe(error);
    }
    return {
      name,
      ok: detail === null,
      durationMs: Math.round(performance.now() - started),
      detail,
    };
  }
}
