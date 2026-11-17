import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { ProviderReauthentication } from './oidc-reauthentication.js';

/** An identity a native app's link found, written once the app completes it. */
export interface NativeIdentity {
  provider: string;
  subject: string;
  email: string | null;
}

/** What a provider's callback runs as, besides a plain sign-in. */
interface AccountFlow {
  /** A step-up through the provider: only this user, freshly authenticated. */
  reauthenticating?: ProviderReauthentication;
  /** A native app's "connect a provider": the account it goes to. */
  linking?: { id: string };
  /** Filled in by the resolver for `linking`: the identity to connect. */
  found?: { identity?: NativeIdentity };
}

const FLOW = Symbol('account-flow');

/**
 * Tells OidcAccounts (the package's resolver, called inside
 * `OidcService.finish()` with no way to pass it anything) what the
 * callback is for: a step-up or a native link. Set around `finish()` in a
 * CLS context; the resolver reads it, and hands back the identity of a
 * native link through the same object.
 *
 * Custom: the package's `finish()` passes the resolver its own `linkTo`
 * (a browser's link) only. iam/auth's SignInContext carries the method,
 * tenant and time of the session; this carries the account's own flows.
 */
@Injectable()
export class AccountFlowContext {
  constructor(private readonly cls: ClsService) {}

  run<T>(
    flow: Omit<AccountFlow, 'found'>,
    fn: () => Promise<T>,
  ): Promise<{ result: T; identity?: NativeIdentity }> {
    const found: NonNullable<AccountFlow['found']> = {};
    return this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set(FLOW, { ...flow, found } satisfies AccountFlow);
      const result = await fn();
      return { result, identity: found.identity };
    });
  }

  reauthenticating() {
    return this.flow()?.reauthenticating;
  }

  linking() {
    return this.flow()?.linking;
  }

  identityToLink(identity: NativeIdentity) {
    const found = this.flow()?.found;
    if (found) {
      found.identity = identity;
    }
  }

  private flow(): AccountFlow | undefined {
    return this.cls.isActive()
      ? this.cls.get<AccountFlow | undefined>(FLOW)
      : undefined;
  }
}
