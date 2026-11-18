import type { DiscoveryService } from '@nestjs/core';
import type { Mailer } from '@nestjs/mail';
import type { Queue } from 'bullmq';
import { Registry } from 'prom-client';
import type { MetricsService } from '../metrics/metrics.service.js';
import { MailBrand } from './mail-brand.js';
import { MailDeliveryPolicy, type MailDelivery } from './mail-delivery.js';
import { EssentialMail } from './mail.essential.js';
import { MAIL_JOB_OPTIONS, MailQueue } from './mail.queue.js';

class Hello {
  render() {
    return { subject: 'Hello', html: '<p>Hi</p>' };
  }
}

@EssentialMail()
class Essential extends Hello {}

describe('MailQueue', () => {
  const rendered = {
    from: { address: 'noreply@example.com', name: 'My API' },
    replyTo: [],
    to: [{ address: 'a@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Hello',
    html: '<p>Hi</p>',
    text: 'Hi',
    headers: {},
    attachments: [] as unknown[],
  };

  function queueWith(
    delivery: 'all' | 'essential' | 'off' = 'all',
    providers: { policy?: Partial<MailDelivery>; brand?: object } = {},
  ) {
    const add = vi.fn(async () => undefined);
    const render = vi.fn(async () => rendered);
    const discovery = {
      getProviders: ({ metadataKey }: { metadataKey: string }) => {
        const instance =
          metadataKey === MailDeliveryPolicy.KEY
            ? providers.policy
            : metadataKey === MailBrand.KEY
              ? providers.brand
              : undefined;
        return instance ? [{ instance }] : [];
      },
    } as unknown as DiscoveryService;
    const registry = new Registry();
    const queue = new MailQueue(
      { add } as unknown as Queue,
      { render } as unknown as Mailer,
      { delivery },
      discovery,
      { registry } as unknown as MetricsService,
    );
    return { queue, add, render };
  }

  it('queues the rendered mail under its class name and job id', async () => {
    const { queue, add } = queueWith();
    await queue.send(Hello, { to: 'a@example.com' } as never, { jobId: 'j1' });
    expect(add).toHaveBeenCalledWith(
      'Hello',
      expect.objectContaining({ subject: 'Hello', to: rendered.to }),
      { jobId: 'j1' },
    );
  });

  it('withholds what MAIL_DELIVERY does not let through', async () => {
    for (const [delivery, mail, options, queued] of [
      ['off', Essential, {}, false],
      ['essential', Hello, {}, false],
      ['essential', Hello, { essential: true }, true],
      ['essential', Essential, {}, true],
    ] as const) {
      const { queue, add } = queueWith(delivery);
      await queue.send(mail, { to: 'a@example.com' } as never, options);
      expect(add).toHaveBeenCalledTimes(queued ? 1 : 0);
    }
  });

  it('lets the delivery policy be stricter than the environment, never looser', async () => {
    for (const [env, mode, queued] of [
      ['all', 'off', false],
      ['all', 'essential', false],
      ['essential', 'all', false],
      ['off', 'all', false],
      ['all', 'all', true],
    ] as const) {
      const { queue, add } = queueWith(env, {
        policy: { mode: async () => mode, consume: async () => true },
      });
      await queue.send(Hello, { to: 'a@example.com' } as never);
      expect(add).toHaveBeenCalledTimes(queued ? 1 : 0);
    }
    const { queue, add } = queueWith('all', {
      policy: { mode: async () => 'essential', consume: async () => true },
    });
    await queue.send(Essential, { to: 'a@example.com' } as never);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('withholds a mail the budget refuses, telling the policy whether it is essential', async () => {
    const consume = vi.fn(
      async ({ essential }: { essential: boolean }) => essential,
    );
    const { queue, add } = queueWith('all', {
      policy: { mode: async () => 'all', consume },
    });
    await queue.send(Hello, { to: 'a@example.com' } as never);
    expect(add).not.toHaveBeenCalled();
    await queue.send(Essential, { to: 'a@example.com' } as never);
    expect(add).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenLastCalledWith({ essential: true });
  });

  it('keeps to the environment when the policy cannot be read', async () => {
    const broken = async () => {
      throw new Error('settings down');
    };
    const open = queueWith('all', {
      policy: { mode: broken, consume: broken },
    });
    await open.queue.send(Hello, { to: 'a@example.com' } as never);
    expect(open.add).toHaveBeenCalledTimes(1);
    const closed = queueWith('off', { policy: { mode: broken } });
    await closed.queue.send(Hello, { to: 'a@example.com' } as never);
    expect(closed.add).not.toHaveBeenCalled();
  });

  it("puts the tenant's name on the sender, unless the mail sets its own; a brand that fails is skipped", async () => {
    const brand = {
      current: async () => ({ name: 'Acme', color: '#000000', logoUrl: null }),
    };
    const { queue, add } = queueWith('all', { brand });
    await queue.send(Hello, { to: 'a@example.com' } as never);
    expect(add).toHaveBeenLastCalledWith(
      'Hello',
      expect.objectContaining({
        from: { address: 'noreply@example.com', name: 'Acme' },
      }),
      expect.anything(),
    );
    await queue.send(Hello, {
      to: 'a@example.com',
      from: 'x@example.com',
    } as never);
    expect(add).toHaveBeenLastCalledWith(
      'Hello',
      expect.objectContaining({ from: rendered.from }),
      expect.anything(),
    );
    const failing = queueWith('all', {
      brand: { current: async () => Promise.reject(new Error('disk')) },
    });
    await failing.queue.send(Hello, { to: 'a@example.com' } as never);
    expect(failing.add).toHaveBeenCalledTimes(1);
  });

  it('refuses a mail with attachments: a job carries none', async () => {
    const { queue, add } = queueWith();
    rendered.attachments = [{}];
    await expect(
      queue.send(Hello, { to: 'a@example.com' } as never),
    ).rejects.toThrow('attachments');
    rendered.attachments = [];
    expect(add).not.toHaveBeenCalled();
  });

  it('stops waiting for Redis when the signal aborts', async () => {
    const { queue, add } = queueWith();
    add.mockImplementation(() => new Promise<undefined>(() => {}));
    const controller = new AbortController();
    const sending = queue.send(Hello, { to: 'a@example.com' } as never, {
      jobId: 'j1',
      signal: controller.signal,
    });
    const outcome = expect(sending).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    controller.abort(new Error('timed out'));
    await outcome;
  });

  it('adds nothing when the signal is already aborted', async () => {
    const { queue, add } = queueWith();
    const controller = new AbortController();
    controller.abort(new Error('timed out'));
    await expect(
      queue.send(Hello, { to: 'a@example.com' } as never, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('timed out');
    expect(add).not.toHaveBeenCalled();
  });

  it('retries for hours, keeping the shared retention', () => {
    expect(MAIL_JOB_OPTIONS).toMatchObject({
      attempts: 10,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnFail: expect.anything(),
    });
  });
});
