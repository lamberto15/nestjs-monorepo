import { randomBytes } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { JwtSigner, JwtVerifier } from '@nestjs/authentication';
import { httpConfig } from '../../core/http/http.config.js';
import { Secrets } from '../../core/secrets/secrets.service.js';

/** The audience and `typ` of a cancel link's token: nothing else accepts one. */
const AUDIENCE = 'account-deletion-cancel';
const TYPE = 'deletion-cancel+jwt';
/** Its own key in core/secrets: an access token's key never verifies one. */
const KEY_SECRET = 'account-deletion-cancel-key';
/** How long after the scheduled date a link still works: the job runs nightly. */
const AFTER_SCHEDULED_MS = 86_400_000;

/** What a valid cancel token names: one deletion request of one user. */
export interface DeletionCancelClaims {
  userId: string;
  deletionId: string;
}

/**
 * The tokens of the deletion mail's "cancel" link: a JWT signed with a key
 * of its own, its own audience and `typ`, naming the user (`sub`) and the
 * request (`did`), expiring a day after the scheduled date. Single use
 * comes from the request it names: only a pending one is cancelled.
 * @nestjs/authentication's JwtSigner and JwtVerifier sign and check it; its
 * email tokens have fixed purposes (reset, verification).
 */
@Injectable()
export class DeletionCancelLinks implements OnModuleInit {
  private signer!: JwtSigner;
  private verifier!: JwtVerifier;

  constructor(
    private readonly secrets: Secrets,
    @Inject(httpConfig.KEY)
    private readonly http: ConfigType<typeof httpConfig>,
  ) {}

  async onModuleInit() {
    const key = Buffer.from(
      await this.secrets.loadOrCreate(KEY_SECRET, () =>
        randomBytes(32).toString('base64url'),
      ),
      'base64url',
    );
    const common = {
      key,
      issuer: this.http.appUrl,
      audience: AUDIENCE,
      type: TYPE,
    };
    this.signer = new JwtSigner(common);
    this.verifier = new JwtVerifier({
      ...common,
      algorithms: ['HS256'],
      required: ['exp', 'sub', 'did'],
    });
  }

  /** The token for a deletion request's mail. */
  sign(deletion: { id: string; userId: string; scheduledFor: Date }) {
    const ttl = Math.max(
      deletion.scheduledFor.getTime() - Date.now() + AFTER_SCHEDULED_MS,
      60_000,
    );
    return this.signer.sign(
      { sub: deletion.userId, did: deletion.id },
      { ttl },
    );
  }

  /** What a token names, or null: badly signed, expired, another kind, malformed. */
  async verify(token: string): Promise<DeletionCancelClaims | null> {
    try {
      const claims = await this.verifier.verify(token);
      return typeof claims.sub === 'string' && typeof claims.did === 'string'
        ? { userId: claims.sub, deletionId: claims.did }
        : null;
    } catch {
      return null;
    }
  }
}
