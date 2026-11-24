import type { DiscoveryService } from '@nestjs/core';
import { type Mailer } from '@nestjs/mail';
import type { Job } from 'bullmq';
import { recordMetrics } from '../../../test/metrics.js';
import { MetricsService } from '../metrics/metrics.service.js';
import {
  type MailSuppression,
  MailSuppressionList,
  normalizeAddress,
  type SuppressionVerdict,
} from './mail-suppression.js';
import { MailProcessor, type QueuedMail } from './mail.queue.js';

const address = (value: string) => ({ address: value });

function job(mail: Partial<QueuedMail> = {}) {
  return {
    id: 'job-1',
    name: 'Hello',
    data: {
      from: address('noreply@example.com'),
      replyTo: [],
      to: [address('Bounced@example.com'), address('fine@example.com')],
      cc: [],
      bcc: [],
      subject: 'Hello',
      headers: {},
      ...mail,
    },
  } as unknown as Job<QueuedMail>;
}

/** A suppression list as deliverability keeps it: complaints give way to essential mail. */
const list: MailSuppression = {
  async check(addresses, { essential }) {
    const verdicts = new Map<string, SuppressionVerdict>();
    for (const raw of addresses) {
      const value = normalizeAddress(raw);
      if (value === 'bounced@example.com') {
        verdicts.set(value, { send: false, reason: 'hard_bounce' });
      } else if (value === 'angry@example.com' && !essential) {
        verdicts.set(value, { send: false, reason: 'complaint' });
      }
    }
    return verdicts;
  },
};

function processor(suppression: MailSuppression | null = list) {
  const send = vi.fn(async () => ({ messageId: 'm1' }));
  const discovery = {
    getProviders: ({ metadataKey }: { metadataKey: string }) =>
      suppression && metadataKey === MailSuppressionList.KEY
        ? [{ instance: suppression }]
        : [],
  } as unknown as DiscoveryService;
  return {
    worker: new MailProcessor(
      { send } as unknown as Mailer,
      discovery,
      new MetricsService(),
    ),
    send,
  };
}

describe('MailProcessor suppression', () => {
  it('drops a suppressed recipient (the address is matched in lower case) and sends to the rest', async () => {
    const { worker, send } = processor();
    const result = await worker.process(job());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: [address('fine@example.com')] }),
    );
    expect(result).toMatchObject({
      messageId: 'm1',
      skipped: [{ address: 'Bounced@example.com', reason: 'hard_bounce' }],
    });
  });

  it('counts the mails sent and the recipients kept back, by reason', async () => {
    const recorded = recordMetrics();
    try {
      const { worker } = processor();
      await worker.process(job());
      await worker.process(job({ to: [address('bounced@example.com')] }));
      expect(await recorded.read('mail_sent')).toEqual([
        { attributes: {}, value: 1 },
      ]);
      const suppressed = await recorded.read('mail_suppressed');
      expect(suppressed).toContainEqual({
        attributes: { reason: 'hard_bounce' },
        value: 2,
      });
      expect(suppressed).toContainEqual({
        attributes: { reason: 'complaint' },
        value: 0,
      });
    } finally {
      await recorded.stop();
    }
  });

  it('does not send a mail with no recipient left', async () => {
    const { worker, send } = processor();
    const result = await worker.process(
      job({ to: [address('bounced@example.com')] }),
    );
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({
      skipped: [{ address: 'bounced@example.com', reason: 'hard_bounce' }],
    });
  });

  it('keeps a complaint from a plain mail but lets an essential one through', async () => {
    const to = [address('angry@example.com')];
    const plain = processor();
    await plain.worker.process(job({ to }));
    expect(plain.send).not.toHaveBeenCalled();

    const essential = processor();
    await essential.worker.process(job({ to, essential: true }));
    expect(essential.send).toHaveBeenCalledWith(
      expect.objectContaining({ to }),
    );
  });

  it('never lets essential mail reach a hard bounce', async () => {
    const { worker, send } = processor();
    await worker.process(
      job({ to: [address('bounced@example.com')], essential: true }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('sends to everyone when no module keeps a list', async () => {
    const { worker, send } = processor(null);
    await worker.process(job());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: job().data.to }),
    );
  });
});
