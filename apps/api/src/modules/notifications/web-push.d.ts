// web-push 4 ships no types: only what notifications.push.ts uses.
declare module 'web-push' {
  export interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  export interface VapidDetails {
    subject: string;
    publicKey: string;
    privateKey: string;
  }
  export class WebPushError extends Error {
    constructor(
      message: string,
      statusCode: number,
      headers: Record<string, string>,
      body: string,
      endpoint: string,
    );
    statusCode: number;
  }
  export function generateVAPIDKeys(): {
    publicKey: string;
    privateKey: string;
  };
  export function sendNotification(
    subscription: PushSubscription,
    payload?: string,
    options?: {
      vapidDetails?: VapidDetails;
      TTL?: number;
      urgency?: 'very-low' | 'low' | 'normal' | 'high';
      timeout?: number;
    },
  ): Promise<{ statusCode: number }>;
}
