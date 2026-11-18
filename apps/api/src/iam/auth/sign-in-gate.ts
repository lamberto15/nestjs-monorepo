import { Injectable, type OnModuleInit, SetMetadata } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { discoverOne } from './discover.js';
import { UsersRepository } from './users.repository.js';

/** Who signs in, as the sign-in routes know them (no principal yet). */
export interface SigningIn {
  id: string;
  email: string;
}

/**
 * A tenant's say in a sign-in by password or passkey, without auth
 * importing the module that decides (iam/sso, which imports auth): that
 * module marks one provider `@SignInGate()`. Without one, every sign-in
 * lands in the user's last chosen tenant.
 */
export interface SignInGateProvider {
  /**
   * The tenant a sign-in by `method` lands in, among the user's tenants
   * (the last chosen first); null for a user of no tenant. Throws (403) when
   * none of them lets the method in.
   */
  signInTenant(
    user: SigningIn,
    method: string,
    ip?: string,
  ): Promise<string | null>;
  /** Throws (403) when `tenantId` doesn't let a sign-in by `method` in. */
  assertSignInTenant(
    user: SigningIn,
    tenantId: string,
    method: string,
    ip?: string,
  ): Promise<void>;
}

/** Marks the provider that implements SignInGateProvider (at most one). */
export const SignInGate = DiscoveryService.createDecorator<void>();

/** The metadata key of WithoutSso(), for the module that enforces "SSO required". */
export const WITHOUT_SSO = Symbol('sso-not-needed');

/**
 * A route a session refused by "SSO required" may still reach: who am I,
 * leaving (signing out, choosing another of one's tenants) and accepting an
 * invitation to another tenant. Only metadata: the module that enforces the
 * rule (iam/sso) reads it.
 */
export const WithoutSso = () => SetMetadata(WITHOUT_SSO, true);

/** The sign-in gate as the sign-in flows use it: the discovered one, else the last chosen tenant. */
@Injectable()
export class SignInGates implements OnModuleInit {
  private gate?: SignInGateProvider;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly users: UsersRepository,
  ) {}

  onModuleInit() {
    this.gate = discoverOne<SignInGateProvider>(
      this.discovery,
      SignInGate,
      'sign-in gate (@SignInGate())',
    );
  }

  /** The tenant a new sign-in by `method` starts in, or a 403 from the gate. */
  tenantFor(user: SigningIn, method: string, ip?: string) {
    return this.gate
      ? this.gate.signInTenant(user, method, ip)
      : this.users.defaultTenant(user.id);
  }

  /** A 403 from the gate when `tenantId` refuses a sign-in by `method`. */
  async assert(user: SigningIn, tenantId: string, method: string, ip?: string) {
    await this.gate?.assertSignInTenant(user, tenantId, method, ip);
  }
}
