/**
 * A sign-in the SSO rules refuse: `reason` is audited
 * (`auth.sign-in-failed`), never shown to the browser, which lands on the
 * web app with `?error=sso_failed`.
 */
export class SsoRefused extends Error {
  constructor(readonly reason: string) {
    super(`SSO sign-in refused: ${reason}`);
    this.name = 'SsoRefused';
  }
}
