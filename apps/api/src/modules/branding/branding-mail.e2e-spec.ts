import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  InMemoryMailTransport,
  type Mailable,
  MailTransport,
} from '@nestjs/mail';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { accessModules, tenantWithAdmin } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { MailModule } from '../../core/mail/mail.module.js';
import { MAIL_QUEUE, MailQueue } from '../../core/mail/mail.queue.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { BrandingModule } from './branding.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.APP_ROLE = 'all';
  process.env.REDIS_PREFIX = `test-branding-mail-${process.pid}-${Date.now()}`;
  process.env.OPERATOR_TENANT = 'operators';
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  process.env.ADMIN_ONBOARDING = 'off';
  process.env.DATA_ENCRYPTION_KEYS = Buffer.alloc(32, 7).toString('base64');
  process.env.STORAGE_DRIVER = 'memory';
  process.env.MAIL_TRANSPORT = 'memory';
});

@Injectable()
class HelloMail implements Mailable<{ name: string }> {
  render({ name }: { name: string }) {
    return {
      subject: 'Hello',
      template: 'fixture-welcome',
      context: { name },
    };
  }
}

describe('branded mail (e2e)', () => {
  let app: NestNodeApplication;
  let mailbox: InMemoryMailTransport;
  let queue: Queue;

  beforeAll(async () => {
    process.env.MAIL_TEMPLATE_ROOTS = join(
      import.meta.dirname,
      '../../../test/fixtures/mail',
    );
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      MailModule,
      StorageModule,
      BrandingModule,
    );
    mailbox = app.get(MailTransport) as InMemoryMailTransport;
    queue = app.get(`BullQueue_${MAIL_QUEUE}`);
  });
  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
  });

  const sendIn = (tenantId: string, to: string) =>
    app
      .get(Tenancy)
      .run(tenantId, () =>
        app.get(MailQueue).send(HelloMail, { to, data: { name: 'Ada' } }),
      );

  it("carries the tenant's colour and sender name, and none from another tenant", async () => {
    const branded = await tenantWithAdmin(app);
    const plain = await tenantWithAdmin(app);
    const set = await app.inject({
      method: 'PUT',
      url: '/v1/branding',
      headers: branded.admin.headers,
      payload: { primaryColor: '#0A84FF', mailFromName: 'Acme Support' },
    });
    expect(set.statusCode).toBe(200);

    await sendIn(branded.tenantId, 'branded@example.com');
    await sendIn(plain.tenantId, 'plain@example.com');
    await vi.waitFor(() => expect(mailbox.mails).toHaveLength(2), {
      timeout: 10_000,
    });
    const to = (address: string) =>
      mailbox.mails.find((mail) => mail.to[0]?.address === address)!;

    const withBrand = to('branded@example.com');
    expect(withBrand.from.name).toBe('Acme Support');
    expect(withBrand.html).toContain('#0A84FF');
    expect(withBrand.html).toContain('Fixture hello Ada');
    const without = to('plain@example.com');
    expect(without.from.name).not.toBe('Acme Support');
    expect(without.html).not.toContain('#0A84FF');
    expect(without.html).toContain('#1f2328');
  });
});
