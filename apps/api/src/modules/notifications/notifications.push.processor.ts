import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { DevicesService } from './notifications.devices.service.js';
import {
  isGone,
  PUSH_QUEUE,
  type PushJob,
  WebPush,
} from './notifications.push.js';

/**
 * The worker's side of web push: sends one message to one browser. A
 * browser the push service says is gone (404, 410) is forgotten; any other
 * failure is retried by the queue with backoff.
 */
@Processor(PUSH_QUEUE, { concurrency: 10 })
export class PushProcessor extends WorkerHost {
  private readonly logger = new Logger('WebPush');

  constructor(
    private readonly devices: DevicesService,
    private readonly webPush: WebPush,
  ) {
    super();
  }

  async process(job: Job<PushJob>) {
    const { deviceId, userId } = job.data;
    // Removed since it was queued, or moved to another account: whoever is
    // signed in on the browser now never sees what was written for userId.
    const device = await this.devices.find(deviceId, userId);
    if (!device) return { sent: false };
    try {
      await this.webPush.send(device, job.data);
      return { sent: true };
    } catch (error) {
      if (isGone(error)) {
        await this.devices.forget(device.id, userId);
        this.logger.log(
          'A browser is gone: its push registration was removed',
          {
            deviceId: device.id,
          },
        );
        throw new UnrecoverableError(
          'The push service says the browser is gone.',
        );
      }
      throw error;
    }
  }
}
