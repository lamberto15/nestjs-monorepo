import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PasswordHasher, SignInService } from '@nestjs/authentication';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { t } from '@nestjs/i18n';
import {
  AUTH_EVENTS,
  type PasswordVerifiedEvent,
  type SignedInEvent,
  type SignInFailedEvent,
} from './auth.events.js';
import { methodMetadata } from './authentication-method.js';
import { sessionTenant } from './impersonation.js';
import { SignInGates } from './sign-in-gate.js';
import { UsersRepository } from './users.repository.js';

export interface SignInRequest {
  ip: string;
  userAgent: string | undefined;
}

/**
 * Signing in with a password, for a browser session. The hashing is the
 * package's PasswordHasher (scrypt), configured by the `password` option
 * (a module may set it with `@AuthenticationOptionsPart()`). Token
 * clients, sign-up, resets and changes are other modules': they verify a
 * password the same way, with `verify()`.
 */
@Injectable()
export class PasswordSignIn {
  constructor(
    private readonly users: UsersRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly signInService: SignInService,
    private readonly events: EventEmitter2,
    private readonly gates: SignInGates,
  ) {}

  /**
   * The account whose password this is, or a 401, announced
   * (`auth.sign-in-failed`, audited). With no account (or none with a
   * password), verify() checks a dummy hash: an unknown email and a wrong
   * password take the same time and get the same answer.
   */
  async verify(email: string, password: string, ip: string) {
    const found = await this.users.findActiveByEmail(email);
    const valid = await this.passwordHasher.verify(
      password,
      found?.passwordHash ?? undefined,
    );
    if (!valid || !found?.passwordHash) {
      await this.events.emitAsync(AUTH_EVENTS.signInFailed, {
        email,
        ...(found && { user: found.user }),
        method: 'password',
        ip,
      } satisfies SignInFailedEvent);
      throw new UnauthorizedException(t('auth.invalidCredentials'));
    }
    // Verify first: a password set before its address was proved (a self
    // sign-up) signs nobody in until the address is, else whoever signed up
    // someone else's address would sign in as them. Told only to whoever
    // knows the password. The first administrator mid-onboarding may sign
    // in with an address not proved yet: a mistyped replacement must not
    // lock the only administrator out.
    if (!found.user.emailVerified && !found.user.onboarding?.email) {
      throw new ForbiddenException({
        code: 'email_unverified',
        message: t('auth.emailUnverified'),
      });
    }
    // The cost settings changed since this hash was stored: upgrade it while we have the plaintext.
    let passwordHash = found.passwordHash;
    if (this.passwordHasher.needsRehash(passwordHash)) {
      const rehashed = await this.passwordHasher.hash(password);
      await this.users.updatePasswordHash(
        found.user.id,
        passwordHash,
        rehashed,
      );
      passwordHash = rehashed;
    }
    // The breach re-check (iam/account) starts here and is not waited for.
    await this.events.emitAsync(AUTH_EVENTS.passwordVerified, {
      user: found.user,
      password,
      passwordHash,
      ip,
    } satisfies PasswordVerifiedEvent);
    return found.user;
  }

  /**
   * Signs the browser in: the session cookie on the response, in the
   * user's last chosen tenant (else the oldest membership) that lets a
   * password in (`@SignInGate()`: 403 `sso_required` when none does). Announced
   * (`auth.signed-in`, audited). With two-factor on, the session is
   * pending until its second factor (`mfaRequired`).
   */
  async signIn(email: string, password: string, request: SignInRequest) {
    const user = await this.verify(email, password, request.ip);
    const tenantId = await this.gates.tenantFor(user, 'password', request.ip);
    const issued = await this.signInService.signIn(user.id, {
      method: 'password',
      metadata: {
        ...methodMetadata('password'),
        ...(tenantId && { tenantId }),
      },
    });
    await this.events.emitAsync(AUTH_EVENTS.signedIn, {
      user,
      method: 'password',
      ip: request.ip,
      userAgent: request.userAgent,
      tenantId: sessionTenant(issued.session),
    } satisfies SignedInEvent);
    const mfaRequired = issued.session.mfa === 'pending';
    return { signedIn: !mfaRequired, mfaRequired };
  }
}
