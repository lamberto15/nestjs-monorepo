import type { Mailer } from '@nestjs/mail';
import type { Queue } from 'bullmq';
import { MAIL_JOB_OPTIONS, MailQueue } from './mail.queue.js';

class Hello {
  render() {
    return { subject: 'Hello', html: '<p>Hi</p>' };
  }
}

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

  function queueWith() {
    const add = vi.fn(async () => undefined);
    const render = vi.fn(async () => rendered);
    const queue = new MailQueue(
      { add } as unknown as Queue,
      { render } as unknown as Mailer,
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
