import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { UserPrincipal } from './principal.js';

/** What a who-am-I part is asked with: the signed-in user and their credential. */
export interface WhoAmIRequest {
  user: UserPrincipal;
  /** The session record or the token's claims (CurrentSession()). */
  session: unknown;
}

/**
 * A slice of `GET /v1/auth/me` another module owns, without auth importing
 * it: mark one provider `@WhoAmIPart(['avatarUrl'])` and give it
 * `whoAmI()`, returning those keys. Only the declared keys are sent.
 */
export interface WhoAmIProvider {
  whoAmI(request: WhoAmIRequest): Promise<Record<string, unknown>>;
}

/**
 * A slice of `GET /v1/auth/methods` (what a sign-in page may offer):
 * mark one provider `@SignInMethodsPart(['magicLink'])` and give it
 * `signInMethods()`, returning those keys.
 */
export interface SignInMethodsProvider {
  signInMethods(): Promise<Record<string, unknown>> | Record<string, unknown>;
}

/** Marks a provider that adds these keys to who-am-I (WhoAmIProvider). */
export const WhoAmIPart = DiscoveryService.createDecorator<readonly string[]>();

/** Marks a provider that adds these keys to the sign-in methods (SignInMethodsProvider). */
export const SignInMethodsPart =
  DiscoveryService.createDecorator<readonly string[]>();

/** The keys auth answers itself: a part may not take them. */
const OWN_ME_KEYS = [
  'user',
  'tenant',
  'mfaEnrollmentRequired',
  'onboardingRequired',
  'session',
];
const OWN_METHOD_KEYS = ['password'];

interface Part<T> {
  keys: readonly string[];
  provider: T;
}

/**
 * The who-am-I and sign-in-methods parts, found at start. A key two
 * providers declare (or one auth answers itself) fails the boot: which
 * one answers would depend on the order modules load.
 */
@Injectable()
export class WhoAmIParts implements OnModuleInit {
  private me: Part<WhoAmIProvider>[] = [];
  private methods: Part<SignInMethodsProvider>[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    this.me = this.find<WhoAmIProvider>(WhoAmIPart, OWN_ME_KEYS, 'who-am-I');
    this.methods = this.find<SignInMethodsProvider>(
      SignInMethodsPart,
      OWN_METHOD_KEYS,
      'sign-in methods',
    );
  }

  /** Every part's keys for this user, merged. */
  async whoAmI(request: WhoAmIRequest) {
    const answers = await Promise.all(
      this.me.map(async ({ keys, provider }) =>
        pick(await provider.whoAmI(request), keys),
      ),
    );
    return Object.assign({}, ...answers) as Record<string, unknown>;
  }

  /** Every part's sign-in methods, merged. */
  async signInMethods() {
    const answers = await Promise.all(
      this.methods.map(async ({ keys, provider }) =>
        pick(await provider.signInMethods(), keys),
      ),
    );
    return Object.assign({}, ...answers) as Record<string, unknown>;
  }

  private find<T>(
    decorator: typeof WhoAmIPart,
    reserved: readonly string[],
    what: string,
  ): Part<T>[] {
    const taken = new Set(reserved);
    const parts: Part<T>[] = [];
    const seen = new Set<unknown>();
    for (const wrapper of this.discovery.getProviders({
      metadataKey: decorator.KEY,
    })) {
      const provider = wrapper.instance as T | undefined;
      if (!provider || seen.has(provider)) continue;
      seen.add(provider);
      const keys =
        this.discovery.getMetadataByDecorator(decorator, wrapper) ?? [];
      for (const key of keys) {
        if (taken.has(key)) {
          throw new Error(
            `Two providers answer "${key}" of the ${what}: keep one.`,
          );
        }
        taken.add(key);
      }
      parts.push({ keys, provider });
    }
    return parts;
  }
}

const pick = (answer: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(
    keys.filter((key) => key in answer).map((key) => [key, answer[key]]),
  );
