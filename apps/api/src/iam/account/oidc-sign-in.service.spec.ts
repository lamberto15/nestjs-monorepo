import { UnauthorizedException, NotFoundException } from '@nestjs/common';
import { OidcService } from '@nestjs/authentication';
import { Test } from '@nestjs/testing';
import { httpConfig } from '../../core/http/http.config.js';
import { authConfig } from '../auth/auth.config.js';
import type { UserPrincipal } from '../auth/principal.js';
import { accountConfig } from './account.config.js';
import { NativeSignIn } from './native-sign-in.service.js';
import { ReauthenticationRefused } from './oidc-reauthentication.js';
import { OidcSignIn } from './oidc-sign-in.service.js';
import { ProviderSignIn } from './provider-sign-in.service.js';

/** OidcSignIn's choice of flow, on stubbed providers: no database, no IdP. */
describe('OidcSignIn', () => {
  const oidc = { start: vi.fn() };
  const providers = { startReauthentication: vi.fn(), signIn: vi.fn() };
  const native = { nativeLogin: vi.fn(), login: vi.fn() };
  const user = {
    kind: 'user',
    id: 'u1',
    emailVerified: true,
  } as unknown as UserPrincipal;
  let flows: OidcSignIn;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        OidcSignIn,
        { provide: OidcService, useValue: oidc },
        { provide: ProviderSignIn, useValue: providers },
        { provide: NativeSignIn, useValue: native },
        {
          provide: accountConfig.KEY,
          useValue: {
            providers: { google: { clientId: 'id', clientSecret: 's' } },
          },
        },
        {
          provide: authConfig.KEY,
          useValue: { reauthenticationMaxAgeMinutes: 10 },
        },
        {
          provide: httpConfig.KEY,
          useValue: { webUrl: 'https://web.example' },
        },
      ],
    }).compile();
    flows = moduleRef.get(OidcSignIn);
  });

  it('answers 404 for a provider without credentials', async () => {
    await expect(
      flows.login(null, undefined, 'gitlab', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('wants a session to link a provider', async () => {
    await expect(
      flows.login(null, undefined, 'google', { link: 'true' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('sends a stale session back to the web app to sign in again first', async () => {
    const { redirect } = await flows.login(user, undefined, 'google', {
      link: 'true',
      redirectTo: '/settings',
    });
    expect(redirect.url).toBe(
      'https://web.example/settings?error=reauthentication_required',
    );
    expect(oidc.start).not.toHaveBeenCalled();
  });

  it("keeps a step-up's state for the browser's cookie", async () => {
    providers.startReauthentication.mockResolvedValue({
      url: 'https://idp.example/auth?state=abc',
    });
    await expect(
      flows.login(user, undefined, 'google', { reauthenticate: 'true' }),
    ).resolves.toMatchObject({ stepUpState: 'abc' });
  });

  it('spends the step-up cookie on a refused step-up, back on the web app', async () => {
    native.login.mockResolvedValue(undefined);
    providers.signIn.mockRejectedValue(
      Object.assign(Object.create(ReauthenticationRefused.prototype), {
        redirectTo: '/x',
      }),
    );
    const result = await flows.callback(
      'google',
      { state: 'abc' },
      { ip: '10.0.0.1', userAgent: undefined },
      'abc',
    );
    expect(result).toMatchObject({
      clearStepUp: true,
      redirect: { url: 'https://web.example/x?error=reauthentication_failed' },
    });
    expect(providers.signIn).toHaveBeenCalledWith(
      'google',
      { state: 'abc' },
      expect.anything(),
      { stepUpExpected: true },
    );
  });
});
