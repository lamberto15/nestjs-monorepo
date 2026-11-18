import { Injectable, Logger } from '@nestjs/common';
import { EmailVerificationService } from '@nestjs/authentication';
import { OnEvent } from '@nestjs/event-emitter';
import type { UserPrincipal } from '../auth/principal.js';

/**
 * The event iam/tenants emits after a sign-up committed (sign-up.service.ts,
 * `SIGN_UP_EVENTS.signedUp`). Named here, not imported: tenants imports
 * invitations, which imports this module, so an import back would close a
 * cycle (root AGENTS.md, rule 4).
 */
export const USER_SIGNED_UP = 'tenancy.user-signed-up';

/**
 * Mails a new sign-up its verification link (verify first: its password
 * signs in once the address is proved). A failure is logged, never the
 * sign-up's: the account is made, and POST /auth/email/verification/resend
 * sends another link.
 */
@Injectable()
export class SignUpMail {
  private readonly logger = new Logger(SignUpMail.name);

  constructor(private readonly emailVerification: EmailVerificationService) {}

  @OnEvent(USER_SIGNED_UP)
  async signedUp({ user }: { user: UserPrincipal }) {
    try {
      await this.emailVerification.send(user);
    } catch (error) {
      this.logger.error(
        'The verification link of a sign-up was not sent',
        error instanceof Error ? error.stack : error,
      );
    }
  }
}
