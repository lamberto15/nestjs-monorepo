import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';

/** The queue of outgoing SMS and push: sent on a worker, never in a request. */
export const MESSAGING = 'messaging';

/** A notification's SMS, to the recipient's verified number. */
export interface SmsJob extends TenantEnvelope {
  kind: 'sms';
  userId: string;
  notificationId: string;
  /** Rendered in the recipient's language when the notification was delivered. */
  text: string;
}

/** The verification code of a number just set: made by the worker, so none rides in the queue. */
export interface CodeJob extends TenantEnvelope {
  kind: 'code';
  userId: string;
}

/** A push to one mobile device. */
export interface PushJob extends TenantEnvelope {
  kind: 'push';
  deviceId: string;
  /** Whose device it was when queued: a token another account registers since keeps the id. */
  userId: string;
  notificationId: string;
  title: string;
  body: string;
  link: string | null;
}

export type MessagingJob = SmsJob | CodeJob | PushJob;
