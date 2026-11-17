import { X509Certificate } from 'node:crypto';

/** How long our SP certificate is valid: the IdP pins it, so long, but not forever. */
const SP_CERTIFICATE_YEARS = 5;

/**
 * Our key pair for one SAML connection (README.md, "What is checked"): it
 * signs the AuthnRequests, and the IdP encrypts assertions to its
 * certificate. A bare self-signed certificate (SAML metadata carries one;
 * no CA needs to sign what the IdP imports), made by `selfsigned`. One per
 * connection, so a leak or a rotation touches one IdP. RSA 3072 (NIST SP
 * 800-57) for a certificate meant to outlive 2030.
 *
 * Loaded when first needed: without the package a SAML connection can't be
 * created (an error), while the rest of SSO works.
 */
export async function newSpKeyPair(commonName: string) {
  const { generate } = await import('selfsigned');
  const now = Date.now();
  const pems = await generate([{ name: 'commonName', value: commonName }], {
    keyType: 'rsa',
    keySize: 3072,
    algorithm: 'sha256',
    notBeforeDate: new Date(now - 60_000),
    notAfterDate: new Date(now + SP_CERTIFICATE_YEARS * 365 * 86_400_000),
  });
  return { privateKey: pems.private, certificate: pems.cert };
}

/** What an administrator sees of a certificate (never a key). */
export function describeCertificate(pem: string) {
  const certificate = new X509Certificate(pem);
  return {
    subject: certificate.subject,
    notAfter: new Date(certificate.validTo).toISOString(),
    fingerprint256: certificate.fingerprint256,
  };
}
