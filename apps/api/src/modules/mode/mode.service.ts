import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { WorkerHost } from '@nestjs/bullmq';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import {
  queuesConfig,
  runsWorkers,
  type QueuesSettings,
} from '../../core/queues/queues.config.js';
import { SettingsService } from '../settings/settings.service.js';
import { modeConfig, type ModeSettings } from './mode.config.js';
import { APP_MODES, type AppMode, PLATFORM_MODE } from './mode.setting.js';

type CronJob = ReturnType<SchedulerRegistry['getCronJob']>;

/** How long a read of the mode is reused: the guard asks on every request. */
const CACHE_MS = 1_000;
/** How often a process looks again, with no request to ask it (workers). */
const POLL_MS = 5_000;

/**
 * The deployment's mode (`normal`, `read-only`, `maintenance`): `APP_MODE`
 * when the environment forces it, else the operators' `platform.mode`
 * setting. Kept for a second per instance and refreshed at once when the
 * platform values change (here, or on another instance through the settings
 * cache). A read that fails keeps the mode last known, never switching a mode
 * on or off by accident.
 *
 * Where workers run (APP_ROLE `worker` or `all`), a restricted mode also
 * pauses this process's queue workers (BullMQ's `Worker.pause()`: jobs wait
 * in Redis, running ones finish) and stops the cron jobs
 * (@nestjs/schedule's `CronJob.stop()`); `normal` resumes both. Custom: no
 * package ties these to a mode of the app.
 */
@Injectable()
export class ModeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Mode');
  private mode: AppMode;
  private readAt = 0;
  private reading: Promise<AppMode> | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** The side effects (workers) last applied for: undefined until the first read. */
  private applied: AppMode | undefined;
  /** The cron jobs this service stopped, to start again. */
  private readonly stopped = new Set<CronJob>();

  constructor(
    private readonly settings: SettingsService,
    @Inject(modeConfig.KEY) private readonly config: ModeSettings,
    @Inject(queuesConfig.KEY) private readonly queues: QueuesSettings,
    private readonly discovery: DiscoveryService,
    private readonly moduleRef: ModuleRef,
    private readonly metrics: MetricsService,
  ) {
    this.mode = config.forced ?? PLATFORM_MODE.default;
    // The environment's mode can't be overridden by a stored one.
    settings.restrict(PLATFORM_MODE, () =>
      config.forced
        ? `The mode is forced to "${config.forced}" by APP_MODE; unset it to change the mode here.`
        : undefined,
    );
    settings.onPlatformChange(() => {
      this.readAt = 0;
      void this.refresh();
    });
  }

  onModuleInit() {
    this.metrics.collect(
      'app_mode',
      'The deployment mode: 1 for the current one (normal, read-only, maintenance).',
      () =>
        APP_MODES.map((mode) => ({
          labels: { mode },
          value: mode === this.mode ? 1 : 0,
        })),
      ['mode'],
    );
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  /** The last known mode, without reading anything. */
  current(): AppMode {
    return this.mode;
  }

  /** The mode, read at most once a second. */
  async get(): Promise<AppMode> {
    if (Date.now() - this.readAt < CACHE_MS) {
      return this.mode;
    }
    return this.refresh();
  }

  /** Reads the mode now (one read at a time) and applies what follows from it. */
  refresh(): Promise<AppMode> {
    this.reading ??= this.read().finally(() => (this.reading = undefined));
    return this.reading;
  }

  private async read(): Promise<AppMode> {
    try {
      this.mode =
        this.config.forced ?? (await this.settings.get(PLATFORM_MODE));
      this.readAt = Date.now();
    } catch (error) {
      // Keep the mode last known; ask again on the next request.
      this.logger.warn('Could not read the mode; keeping the last one.', {
        error: String(error),
      });
      return this.mode;
    }
    await this.apply(this.mode);
    return this.mode;
  }

  /**
   * The scheduler, where ScheduleModule is loaded (not with SCHEDULER=off).
   * Looked up, not injected: the module is registered conditionally
   * (core/locks) and may be absent.
   */
  private scheduler(): SchedulerRegistry | undefined {
    try {
      return this.moduleRef.get(SchedulerRegistry, { strict: false });
    } catch {
      return undefined;
    }
  }

  /** This process's queue workers (the consumers of @Processor classes). */
  private workers() {
    return this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance as unknown)
      .filter(
        (instance): instance is WorkerHost =>
          instance instanceof WorkerHost && instance['_worker'] !== undefined,
      )
      .map((host) => host.worker);
  }

  private async apply(mode: AppMode) {
    if (!runsWorkers(this.queues.role)) {
      return;
    }
    // Cron jobs: stopped every time (one registered late is caught too).
    const schedule = this.scheduler();
    if (!schedule) {
      // nothing to stop or start
    } else if (mode === 'normal') {
      for (const job of this.stopped) job.start();
      this.stopped.clear();
    } else {
      for (const job of schedule.getCronJobs().values()) {
        if (job.isActive) {
          await job.stop();
          this.stopped.add(job);
        }
      }
    }
    if (this.applied === mode) {
      return;
    }
    try {
      for (const worker of this.workers()) {
        if (worker.isRunning()) {
          if (mode === 'normal') await worker.resume();
          else await worker.pause();
        }
      }
      this.applied = mode;
      this.logger.log(`Mode ${mode}.`);
    } catch (error) {
      // Tried again on the next tick.
      this.logger.warn(`Could not apply the mode ${mode} to the queues.`, {
        error: String(error),
      });
    }
  }
}
