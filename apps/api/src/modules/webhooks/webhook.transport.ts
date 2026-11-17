import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  HttpWebhookTransport,
  type ResolvedAddress,
  WebhookDestinationBlockedError,
  type WebhookRequest,
  WebhooksStorage,
  WebhookTransport,
  type WebhookTransportResponse,
  type WebhookTransportSendOptions,
} from '@nestjs/webhooks';
import type { Database } from '../../core/database/database.js';
import { addressAllowed } from '../../core/http/safe-fetch.js';
import { webhooksConfig } from './webhooks.config.js';
import {
  type SigningSecret,
  webhookDeliveryRequests,
} from './webhooks.tables.js';

type Config = ConfigType<typeof webhooksConfig>;

/** The one address WEBHOOKS_ALLOW_LOOPBACK opens, as in the earlier template: not other private ranges. */
const LOOPBACK = '127.0.0.1';

/** Whether a webhook may be sent to `address`: safeFetch's address rules (core/http), and 127.0.0.1 with WEBHOOKS_ALLOW_LOOPBACK. */
export const destinationAllowed = (address: string, config: Config) =>
  addressAllowed(address) || (config.allowLoopback && address === LOOPBACK);

/** The package's own URL and address checks, the same way: https only unless WEBHOOKS_ALLOW_LOOPBACK. */
export const deliveryOptions = (config: Config) => ({
  allowHttp: config.allowLoopback,
  allowedAddresses: config.allowLoopback ? [`${LOOPBACK}/32`] : [],
});

/** The URL's host as a socket uses it: without IPv6 brackets. */
const hostOf = (url: string) =>
  new URL(url).hostname.replace(/^\[(.*)\]$/, '$1');

/** Every address `hostname` resolves to, or a WebhookDestinationBlockedError for the first refused one. */
async function resolveAllowed(
  hostname: string,
  config: Config,
): Promise<ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, order: 'verbatim' });
  const refused = addresses.find(
    (entry) => !destinationAllowed(entry.address, config),
  );
  if (refused) {
    throw new WebhookDestinationBlockedError(
      hostname,
      `${hostname} resolves to ${refused.address}`,
      refused.address,
    );
  }
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
}

/**
 * Why a tenant's URL is refused as an endpoint, checked when it is saved:
 * an IP literal, or a host resolving now, to an address the rules refuse.
 * A host that doesn't resolve is accepted (the delivery fails and retries);
 * every delivery is checked again anyway (SafeWebhookTransport).
 */
export async function destinationRefusal(
  url: string,
  config: Config,
): Promise<string | undefined> {
  let host: string;
  try {
    host = hostOf(url);
  } catch {
    return undefined; // not a URL: the package refuses it with its own message
  }
  // Plain HTTP only to the loopback address WEBHOOKS_ALLOW_LOOPBACK allows.
  if (new URL(url).protocol === 'http:' && host !== LOOPBACK) {
    return 'plain http is refused: use https';
  }
  if (isIP(host)) {
    return destinationAllowed(host, config) ? undefined : `${host} is refused`;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return undefined;
  const check = resolveAllowed(host, config).then(
    () => undefined,
    (error: unknown) =>
      error instanceof WebhookDestinationBlockedError
        ? error.reason
        : undefined,
  );
  // A slow resolver doesn't hold the request: the delivery checks again.
  return Promise.race([
    check,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), 3000).unref(),
    ),
  ]);
}

/**
 * The package's HTTP transport (one POST per attempt, the socket pinned to
 * the checked address, redirects never followed, the response cut at 4 KB),
 * with safeFetch's address rules on top: its `lookup` refuses a host any of
 * whose addresses is private, loopback, link-local or metadata, at connect
 * time, every attempt. A refusal fails the delivery without a retry.
 *
 * It also records the request it is about to send for the delivery log
 * (`lastRequest`). Custom: the package logs each attempt's response, not
 * its request, and a transport is its documented place to wrap sending. A
 * failed write is logged and the webhook is sent anyway.
 */
@Injectable()
export class SafeWebhookTransport extends WebhookTransport {
  private readonly logger = new Logger('Webhooks');
  private readonly http: HttpWebhookTransport;

  constructor(
    @Inject(webhooksConfig.KEY) private readonly config: Config,
    @InjectDrizzle() private readonly db: Database,
    private readonly storage: WebhooksStorage,
  ) {
    super();
    this.http = new HttpWebhookTransport({
      ...deliveryOptions(config),
      lookup: (hostname) => resolveAllowed(hostname, config),
    });
  }

  async send(
    request: WebhookRequest,
    options: WebhookTransportSendOptions,
  ): Promise<WebhookTransportResponse> {
    const host = hostOf(request.url);
    if (isIP(host) && !destinationAllowed(host, this.config)) {
      throw new WebhookDestinationBlockedError(
        request.url,
        `${host} is refused`,
        host,
      );
    }
    await this.record(request, options.attempt);
    return this.http.send(request, options);
  }

  private async record(request: WebhookRequest, attempt: number) {
    try {
      const row = {
        attempt,
        headers: { ...request.headers },
        sentAt: new Date(),
        signedWith: await this.signingSecrets(request),
      };
      await this.db
        .insert(webhookDeliveryRequests)
        .values({ deliveryId: request.deliveryId, ...row })
        .onConflictDoUpdate({
          target: webhookDeliveryRequests.deliveryId,
          set: row,
        });
    } catch (error) {
      this.logger.warn(
        `Could not record the request of webhook delivery ${request.deliveryId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * The secrets that signed this request, an approximation: the worker
   * signs with every live secret of the endpoint (newest first; two after a
   * rotation) and says neither which nor their ids. So the endpoint's live
   * secrets are read again and matched to the signatures by count; a count
   * that differs (one expired or was rotated in between) records null.
   * Only when each was made and ends, never the secret.
   */
  private async signingSecrets(
    request: WebhookRequest,
  ): Promise<SigningSecret[] | null> {
    const endpoint = await this.storage.endpoints.getEndpoint(
      request.endpointId,
    );
    const now = Date.now();
    const live = (endpoint?.secrets ?? []).filter(
      (secret) => secret.expiresAt === null || secret.expiresAt > now,
    );
    const signatures = (request.headers['webhook-signature'] ?? '')
      .split(' ')
      .filter((entry) => entry.startsWith('v1,'));
    return live.length > 0 && live.length === signatures.length
      ? live.map(({ createdAt, expiresAt }) => ({ createdAt, expiresAt }))
      : null;
  }
}
