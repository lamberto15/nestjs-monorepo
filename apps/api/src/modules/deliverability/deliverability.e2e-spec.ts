import {
  createSign,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
} from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq } from 'drizzle-orm';
import { accessModules, member } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { RolesService } from '../../iam/access/roles.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { DeliverabilityModule } from './deliverability.module.js';
import { mailEvents, mailSuppressions } from './deliverability.tables.js';
import { publicKeyOf, SnsGateway } from './intake/sns-gateway.js';
import { type SnsMessage, snsStringToSign } from './intake/sns-message.js';
import { MailEventsRetentionJob } from './mail-events.retention.job.js';
import type { MailSuppression } from '../../core/mail/mail-suppression.js';
import { SuppressionsService } from './suppressions.service.js';

const TOPIC = 'arn:aws:sns:eu-central-1:123456789012:ses-feedback';
const OPERATORS = vi.hoisted(() => {
  const slug = `ops-${Date.now().toString(36)}`;
  process.env.OPERATOR_TENANT = slug;
  process.env.SES_SNS_TOPIC_ARNS =
    'arn:aws:sns:eu-central-1:123456789012:ses-feedback';
  process.env.MAIL_SOFT_BOUNCE_THRESHOLD = '2';
  process.env.POSTMARK_WEBHOOK_SECRET = 'pm-secret';
  process.env.SCHEDULER = 'off';
  process.env.APP_ROLE = 'all';
  process.env.REDIS_PREFIX = `test-deliverability-${process.pid}-${Date.now()}`;
  return slug;
});

/** The key pair standing in for SNS's; the fake gateway serves its public key. */
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const CERT_URL =
  'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-e2e.pem';

class FakeGateway implements SnsGateway {
  readonly confirmed: string[] = [];
  async certificate(): Promise<KeyObject> {
    return publicKeyOf(
      publicKey.export({ type: 'spki', format: 'pem' }) as string,
    );
  }
  async confirm(url: string) {
    this.confirmed.push(url);
  }
}

/** An SNS notification carrying an SES message, signed as SNS signs it. */
function snsNotification(
  message: object | string,
  overrides: Partial<SnsMessage> = {},
  key = privateKey,
): SnsMessage {
  const notification: SnsMessage = {
    Type: 'Notification',
    MessageId: randomUUID(),
    TopicArn: TOPIC,
    Subject: 'Amazon SES Email Event Notification',
    Message: typeof message === 'string' ? message : JSON.stringify(message),
    Timestamp: new Date().toISOString(),
    SignatureVersion: '1',
    SigningCertURL: CERT_URL,
    Signature: '',
    ...overrides,
  };
  notification.Signature = createSign(
    notification.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256',
  )
    .update(snsStringToSign(notification), 'utf8')
    .sign(key, 'base64');
  return notification;
}

const bounce = (address: string, bounceType = 'Permanent') => ({
  notificationType: 'Bounce',
  bounce: {
    bounceType,
    bounceSubType: bounceType === 'Permanent' ? 'General' : 'MailboxFull',
    bouncedRecipients: [
      { emailAddress: address, status: '5.1.1', diagnosticCode: 'smtp; 550' },
    ],
    timestamp: new Date().toISOString(),
  },
});
const complaint = (address: string) => ({
  notificationType: 'Complaint',
  complaint: {
    complainedRecipients: [{ emailAddress: address }],
    complaintFeedbackType: 'abuse',
    timestamp: new Date().toISOString(),
  },
});
const delivery = (address: string) => ({
  notificationType: 'Delivery',
  delivery: { recipients: [address], timestamp: new Date().toISOString() },
});

describe('email deliverability (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;
  let suppression: MailSuppression;
  let gateway: FakeGateway;
  let admin: Record<string, string>;
  let tenantId: string;
  let editor: Record<string, string>;

  beforeAll(async () => {
    gateway = new FakeGateway();
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      MetricsModule,
      DeliverabilityModule,
    );
    // No AWS in a test: the gateway that fetches certificates and confirms subscriptions is replaced.
    const real = app.get(SnsGateway);
    vi.spyOn(real, 'certificate').mockImplementation(() =>
      gateway.certificate(),
    );
    vi.spyOn(real, 'confirm').mockImplementation((url) => gateway.confirm(url));
    db = app.get<Database>(getDrizzleToken());
    suppression = app.get(SuppressionsService);
    // The operators' tenant: the first-boot seed made it, with its roles.
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, OPERATORS));
    tenantId = tenant!.id;
    admin = (await member(app, tenantId, ['administrator'])).headers;
    editor = (await member(app, tenantId, ['editor'])).headers;
  });
  afterAll(() => app.close());

  /** Posts as SNS does: JSON as text/plain. */
  const post = (body: SnsMessage | string, provider = 'ses') =>
    app.inject({
      method: 'POST',
      url: `/v1/webhooks/mail/${provider}`,
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
      payload: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const get = (url: string, headers = admin) =>
    app.inject({ method: 'GET', url, headers });

  /** The list entry of an address once the queue has written it. */
  async function entry(
    address: string,
    until: (row: Record<string, any>) => boolean = () => true,
  ) {
    for (let tries = 0; tries < 200; tries++) {
      const page = await get(
        `/v1/mail/suppressions?address=${encodeURIComponent(address)}`,
      );
      const row = page.json().items?.[0];
      if (row && until(row)) return row as Record<string, any>;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }

  it('suppresses a hard-bounced address from a signed SNS notification, once, with an audit entry by the intake job', async () => {
    const address = `Bounced-${randomUUID().slice(0, 6)}@Example.com`;
    const notification = snsNotification(bounce(address));
    const first = await post(notification);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ received: true, kind: 'events', events: 1 });
    const row = await entry(address);
    expect(row).toMatchObject({
      address: address.toLowerCase(),
      reason: 'hard_bounce',
      source: 'ses',
      events: 1,
      lastDetail: 'Permanent/General: 5.1.1: smtp; 550',
      createdBy: 'system:mail-intake',
    });
    expect(row!.suppressedAt).not.toBeNull();

    // SNS redelivers the same message: accepted, nothing changes.
    expect((await post(notification)).statusCode).toBe(200);
    await post(
      snsNotification(bounce(address), {
        MessageId: notification.MessageId,
        Timestamp: notification.Timestamp,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await entry(address))!.events).toBe(1);

    // The intake's entry is in no tenant's log (the list is the deployment's).
    const audit = await app
      .get(Tenancy)
      .run(null, () =>
        db.select().from(auditLog).where(eq(auditLog.targetId, row!.id)),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'mailSuppression.created',
      actor: 'system:mail-intake',
    });
  });

  it('counts soft bounces, resets them on a delivery, and suppresses at the threshold', async () => {
    const address = `soft-${randomUUID().slice(0, 6)}@example.com`;
    await post(snsNotification(bounce(address, 'Transient')));
    expect(await entry(address)).toMatchObject({
      reason: 'soft_bounce',
      softBounces: 1,
      suppressedAt: null,
    });
    await post(snsNotification(delivery(address)));
    expect(await entry(address, (row) => row.softBounces === 0)).toBeDefined();
    await post(snsNotification(bounce(address, 'Transient')));
    await post(snsNotification(bounce(address, 'Undetermined')));
    expect(
      await entry(address, (row) => row.suppressedAt !== null),
    ).toMatchObject({ reason: 'soft_bounce', softBounces: 2, events: 3 });
  });

  it('keeps the strongest reason: a complaint outranks a later hard bounce, a hard bounce replaces a soft one', async () => {
    const address = `rank-${randomUUID().slice(0, 6)}@example.com`;
    await post(snsNotification(complaint(address)));
    const complained = await entry(address);
    expect(complained).toMatchObject({
      reason: 'complaint',
      lastDetail: 'abuse',
    });
    await post(snsNotification(bounce(address)));
    expect(await entry(address, (row) => row.events === 2)).toMatchObject({
      reason: 'complaint',
      suppressedAt: complained!.suppressedAt,
    });
    const soft = `soft-hard-${randomUUID().slice(0, 6)}@example.com`;
    await post(snsNotification(bounce(soft, 'Transient')));
    await entry(soft);
    await post(snsNotification(bounce(soft), { SignatureVersion: '2' }));
    expect(await entry(soft, (row) => row.suppressedAt !== null)).toMatchObject(
      { reason: 'hard_bounce', softBounces: 0 },
    );
  });

  it('refuses what is not a signed SNS message from the configured topic, and confirms a subscription', async () => {
    const address = `refused-${randomUUID().slice(0, 6)}@example.com`;
    const code = async (body: SnsMessage | string, status: number) => {
      const response = await post(body);
      expect(response.statusCode).toBe(status);
      return response.json().code;
    };
    expect(await code('not json', 400)).toBe('sns_malformed');
    expect((await post('', 'ses')).statusCode).toBe(400);
    expect(
      (await post(snsNotification(bounce(address)), 'mailgun')).statusCode,
    ).toBe(404);
    const forged = snsNotification(bounce(address));
    forged.Message = JSON.stringify(bounce(address, 'Transient'));
    expect(await code(forged, 401)).toBe('sns_signature_invalid');
    expect(
      await code(
        snsNotification(
          bounce(address),
          {},
          generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
        ),
        401,
      ),
    ).toBe('sns_signature_invalid');
    expect(
      await code(
        snsNotification(bounce(address), { TopicArn: `${TOPIC}-other` }),
        403,
      ),
    ).toBe('sns_topic_not_allowed');
    expect(
      await code(
        snsNotification(bounce(address), {
          Timestamp: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        }),
        400,
      ),
    ).toBe('sns_stale');
    expect(
      await code(
        snsNotification(bounce(address), {
          SigningCertURL: 'https://evil.example/c.pem',
        }),
        401,
      ),
    ).toBe('sns_certificate_refused');
    // The JSON parser's path (a sender that sets application/json): the raw bytes are what is verified.
    const json = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/mail/ses',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(snsNotification({ eventType: 'Open' })),
    });
    expect(json.json().kind).toBe('ignored');
    expect(
      (await get(`/v1/mail/suppressions?address=${address}`)).json().items,
    ).toEqual([]);

    const subscribe =
      'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=t';
    const confirmation = snsNotification('You have chosen to subscribe', {
      Type: 'SubscriptionConfirmation',
      SubscribeURL: subscribe,
      Token: 't',
      Subject: undefined,
    });
    const confirmed = await post(confirmation);
    expect(confirmed.json()).toEqual({
      received: true,
      kind: 'handshake',
      events: 0,
    });
    expect(gateway.confirmed).toEqual([subscribe]);
  });

  it('takes Postmark’s bounces, with its shared secret', async () => {
    const address = `pm-${randomUUID().slice(0, 6)}@example.com`;
    const body = JSON.stringify({
      RecordType: 'Bounce',
      ID: 4242,
      Type: 'HardBounce',
      Email: address,
      BouncedAt: new Date().toISOString(),
      Details: 'no such user',
    });
    const send = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/v1/webhooks/mail/postmark',
        headers: { 'content-type': 'application/json', ...headers },
        payload: body,
      });
    expect((await send({})).statusCode).toBe(401);
    expect(
      (await send({ 'x-postmark-webhook-secret': 'pm-secret' })).statusCode,
    ).toBe(200);
    expect(await entry(address)).toMatchObject({
      reason: 'hard_bounce',
      source: 'postmark',
    });
  });

  it('answers the sender: skips bounced and manual addresses, lets essential mail through a complaint or a soft bounce, and expires a soft-bounce suppression', async () => {
    const hard = `hard-${randomUUID().slice(0, 6)}@example.com`;
    const spam = `spam-${randomUUID().slice(0, 6)}@example.com`;
    const soft = `soft-${randomUUID().slice(0, 6)}@example.com`;
    await post(snsNotification(bounce(hard)));
    await post(snsNotification(complaint(spam)));
    await post(snsNotification(bounce(soft, 'Transient')));
    await post(snsNotification(bounce(soft, 'Transient')));
    await entry(hard);
    await entry(spam);
    const suppressedSoft = await entry(
      soft,
      (row) => row.suppressedAt !== null,
    );

    const all = [hard.toUpperCase(), spam, soft, 'fine@example.com'];
    const plain = await suppression.check(all, {
      essential: false,
      mail: 'News',
    });
    expect(plain.get(hard)).toEqual({ send: false, reason: 'hard_bounce' });
    expect(plain.get(spam)).toEqual({ send: false, reason: 'complaint' });
    expect(plain.get(soft)).toEqual({ send: false, reason: 'soft_bounce' });
    expect(plain.has('fine@example.com')).toBe(false);

    // Essential mail: the person asked for it, and the mailbox exists.
    const essential = await suppression.check(all, {
      essential: true,
      mail: 'Reset',
    });
    expect([...essential.keys()]).toEqual([hard]);
    expect(await entry(hard, (row) => row.skipped === 2)).toBeDefined();
    expect(await entry(spam, (row) => row.skipped === 1)).toBeDefined();

    // 73 hours later the soft-bounce suppression has expired: watched again.
    await db
      .update(mailSuppressions)
      .set({ suppressedAt: new Date(Date.now() - 73 * 3_600_000) })
      .where(eq(mailSuppressions.id, suppressedSoft!.id));
    expect(
      (await suppression.check([soft], { essential: false, mail: 'News' }))
        .size,
    ).toBe(0);
    expect(await entry(soft, (row) => row.suppressedAt === null)).toMatchObject(
      {
        softBounces: 0,
      },
    );
  });

  it('lets operators add and remove entries, audited; no one else may', async () => {
    expect((await get('/v1/mail/suppressions', editor)).statusCode).toBe(403);
    const forbidden = await app.inject({
      method: 'POST',
      url: '/v1/mail/suppressions',
      headers: editor,
      payload: { address: 'x@example.com' },
    });
    expect(forbidden.statusCode).toBe(403);
    // Not the operators' tenant: an administrator of another is refused too.
    const other = await app
      .get(Tenancy)
      .create({ slug: `other-${Date.now().toString(36)}`, name: 'Other' });
    await app
      .get(Tenancy)
      .run(other.id, () =>
        app
          .get(TransactionHost)
          .withTransaction(() => app.get(RolesService).seedTenantRoles()),
      );
    const outsider = await member(app, other.id, ['administrator']);
    const refused = await get('/v1/mail/suppressions', outsider.headers);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('operator_required');

    const address = `Manual-${randomUUID().slice(0, 6)}@Example.com`;
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/mail/suppressions',
      headers: admin,
      payload: { address: 'nope' },
    });
    expect(bad.statusCode).toBe(400);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/mail/suppressions',
      headers: admin,
      payload: { address, note: 'Asked us to stop by phone' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      address: address.toLowerCase(),
      reason: 'manual',
      source: 'manual',
      note: 'Asked us to stop by phone',
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/mail/suppressions',
      headers: admin,
      payload: { address: address.toUpperCase() },
    });
    expect(duplicate.statusCode).toBe(409);

    // A manual entry stops essential mail too.
    const verdict = await suppression.check([address], {
      essential: true,
      mail: 'Reset',
    });
    expect(verdict.get(address.toLowerCase())).toEqual({
      send: false,
      reason: 'manual',
    });

    const id = created.json().id as string;
    expect((await get(`/v1/mail/suppressions/${id}`)).statusCode).toBe(200);
    const del = (headers: Record<string, string>) =>
      app.inject({
        method: 'DELETE',
        url: `/v1/mail/suppressions/${id}`,
        headers,
      });
    expect((await del(editor)).statusCode).toBe(403);
    expect((await del(admin)).statusCode).toBe(204);
    expect((await del(admin)).statusCode).toBe(404);
    expect(
      (await suppression.check([address], { essential: false, mail: 'News' }))
        .size,
    ).toBe(0);

    const actions = await app
      .get(Tenancy)
      .run(tenantId, () =>
        db
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.targetId, id)),
      );
    expect(actions.map((row) => row.action).sort()).toEqual([
      'mailSuppression.created',
      'mailSuppression.deleted',
    ]);
  });

  it('prunes events past MAIL_EVENTS_RETENTION_DAYS and keeps the list', async () => {
    const retention = app.get(MailEventsRetentionJob);
    expect(await retention.run(new Date())).toBe(0);
    const total = (await db.select().from(mailEvents)).length;
    expect(total).toBeGreaterThan(0);
    expect(await retention.run(new Date(Date.now() + 91 * 86_400_000))).toBe(
      total,
    );
    expect((await db.select().from(mailSuppressions)).length).toBeGreaterThan(
      0,
    );
  });
});
