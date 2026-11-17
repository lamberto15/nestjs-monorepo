import { Injectable } from '@nestjs/common';
import {
  InMemoryMailTransport,
  type Mailable,
  MailSmtpError,
  MailTransport,
} from '@nestjs/mail';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { bootModules } from '../../../test/boot.js';
import { QueuesModule } from '../queues/queues.module.js';
import { MailModule } from './mail.module.js';
import { MAIL_QUEUE, MailQueue } from './mail.queue.js';

@Injectable()
class WelcomeMail implements Mailable<{ name: string }> {
  render({ name }: { name: string }) {
    return { subject: `Welcome ${name}`, html: `<p>Hi ${name}</p>` };
  }
}

describe('mail', () => {
  let app: NestNodeApplication;
  let mailQueue: MailQueue;
  let mailbox: InMemoryMailTransport;
  let queue: Queue;

  beforeAll(async () => {
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.APP_ROLE = 'all';
    process.env.REDIS_PREFIX = `test-mail-${process.pid}`;
    app = await bootModules(QueuesModule, MailModule);
    mailQueue = app.get(MailQueue);
    mailbox = app.get(MailTransport) as InMemoryMailTransport;
    queue = app.get(`BullQueue_${MAIL_QUEUE}`);
    await queue.obliterate({ force: true });
  });

  beforeEach(() => mailbox.clear());

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
    delete process.env.MAIL_TRANSPORT;
    delete process.env.APP_ROLE;
    delete process.env.REDIS_PREFIX;
  });

  it('sends a queued mail from the worker, wrapped in the layout', async () => {
    await mailQueue.send(WelcomeMail, {
      to: 'ada@example.com',
      data: { name: 'Ada' },
    });
    await vi.waitFor(() => expect(mailbox.mails).toHaveLength(1), {
      timeout: 5000,
    });
    const [mail] = mailbox.mails;
    expect(mail?.subject).toBe('Welcome Ada');
    expect(mail?.to[0]?.address).toBe('ada@example.com');
    expect(mail?.html).toContain('Hi Ada');
  });

  it('sends once when the same job id is queued twice', async () => {
    const options = { to: 'b@example.com', data: { name: 'B' } };
    await mailQueue.send(WelcomeMail, options, { jobId: 'same' });
    await mailQueue.send(WelcomeMail, options, { jobId: 'same' });
    await vi.waitFor(() => expect(mailbox.mails).toHaveLength(1), {
      timeout: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mailbox.mails).toHaveLength(1);
  });

  it('fails at once on a refusal that will not change', async () => {
    mailbox.failNext(
      new MailSmtpError('RCPT TO', { code: 550, text: 'User unknown' }),
    );
    await mailQueue.send(
      WelcomeMail,
      {
        to: 'nobody@example.com',
        data: { name: 'N' },
      },
      { jobId: 'refused' },
    );
    await vi.waitFor(
      async () =>
        expect(
          await queue.getJob('refused').then((j) => j?.finishedOn),
        ).toBeTruthy(),
      { timeout: 5000 },
    );
    const job = await queue.getJob('refused');
    expect(await job?.getState()).toBe('failed');
    expect(job?.attemptsMade).toBe(1);
    expect(mailbox.mails).toHaveLength(0);
  });

  it('keeps a mail for a retry when the provider is down for now', async () => {
    mailbox.failNext(new Error('connection reset'));
    await mailQueue.send(
      WelcomeMail,
      {
        to: 'c@example.com',
        data: { name: 'C' },
      },
      { jobId: 'transient' },
    );
    await vi.waitFor(
      async () =>
        expect(await (await queue.getJob('transient'))?.getState()).toBe(
          'delayed',
        ),
      { timeout: 5000 },
    );
  });
});
