import { randomBytes } from 'node:crypto';
import { InMemoryMailTransport, MailTransport } from '@nestjs/mail';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { getQueueToken } from '@nestjs/bullmq';
import { accessModules } from '../../../test/access.js';
import { browser, CheapPasswordsModule } from '../../../test/account.js';
import { createUser } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import { MAIL_QUEUE } from '../../core/mail/mail.queue.js';
import { SharedOutboxModule } from '../../core/outbox/outbox.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { SecretsModule } from '../../core/secrets/secrets.module.js';
import { AccountModule } from '../../iam/account/account.module.js';
import { NotificationsModule } from './notifications.module.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-notifications-security-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    PASSWORD_BREACH_CHECK: 'off',
  });
});

describe('security notifications (e2e)', () => {
  let app: NestNodeApplication;
  let mailbox: InMemoryMailTransport;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      SecretsModule,
      SharedOutboxModule,
      AccountModule,
      CheapPasswordsModule,
      NotificationsModule,
    );
    mailbox = app.get(MailTransport) as InMemoryMailTransport;
  });
  afterAll(async () => {
    await app
      ?.get<Queue>(getQueueToken(MAIL_QUEUE))
      .obliterate({ force: true });
    await app?.close();
  });

  it("stores an account's security alert in the tenant it acted in, with the account's one mail", async () => {
    const user = await createUser(app);
    const agent = browser(app);
    await agent.post('/v1/auth/sign-in', {
      email: user.email,
      password: user.password,
    });
    const changed = await agent.post('/v1/auth/password/change', {
      currentPassword: user.password,
      newPassword: `new ${randomBytes(12).toString('hex')} pass`,
    });
    expect(changed.statusCode).toBe(204);

    await vi.waitFor(
      async () => {
        const list = await agent.get('/v1/notifications');
        expect(list.statusCode).toBe(200);
        expect(list.json().items).toEqual([
          expect.objectContaining({
            type: 'security.password-changed',
            title: 'Password changed',
            link: '/account/security',
          }),
        ]);
      },
      { timeout: 30_000, interval: 250 },
    );
    await vi.waitFor(
      () =>
        expect(
          mailbox.mails.filter((mail) =>
            mail.to.some((to) => to.address === user.email),
          ),
        ).toHaveLength(1),
      { timeout: 15_000 },
    );
    const [mail] = mailbox.mails.filter((m) =>
      m.to.some((to) => to.address === user.email),
    );
    expect(mail!.subject).toBe('Your password was changed');

    // Mandatory: listed in the preferences, never switched off.
    const preferences = await agent.get('/v1/notifications/preferences');
    expect(preferences.statusCode).toBe(200);
    expect(JSON.stringify(preferences.json())).toContain(
      'security.password-changed',
    );
  });
});
