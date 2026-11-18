import {
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign,
  X509Certificate,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { SsoProcessor } from '../src/iam/sso/sso.processor.js';
import type { TxtResolver } from '../src/iam/sso/sso.queue.js';

/**
 * Test doubles of a tenant's identity provider (src/iam/sso/README.md): no
 * real IdP, no committed key. Keys and certificates are made at run time;
 * SAML responses are signed with xml-crypto as an IdP signs them; the
 * OpenID Connect and OAuth 2.0 providers are servers on loopback
 * (SSO_ALLOW_LOOPBACK).
 */

// CommonJS packages (devDependencies, at the versions @node-saml/node-saml uses).
const fromNodeSaml = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { SignedXml } = fromNodeSaml('xml-crypto') as { SignedXml: any };
const xmlenc = fromNodeSaml('xml-encryption') as {
  encrypt(
    content: string,
    options: Record<string, unknown>,
    done: (error: Error | null, result: string) => void,
  ): void;
};

// DER, for a certificate made here: Node can sign but has no X.509 builder.
const der = (tag: number, content: Buffer) => {
  const length = content.length;
  const head =
    length < 0x80
      ? Buffer.from([length])
      : (() => {
          const bytes = Buffer.from(
            length.toString(16).padStart(8, '0'),
            'hex',
          );
          const trimmed = bytes.subarray(bytes.findIndex((b) => b !== 0));
          return Buffer.concat([Buffer.from([0x80 | trimmed.length]), trimmed]);
        })();
  return Buffer.concat([Buffer.from([tag]), head, content]);
};
const seq = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
/**
 * A non-negative DER INTEGER: minimal, so leading zero bytes go (a random
 * serial starting 0x00 0x01… is "illegal padding" to OpenSSL), and a zero
 * goes back in front of a high bit so it stays positive.
 */
const integer = (raw: Buffer) => {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start++;
  const bytes = raw.subarray(start);
  return der(
    0x02,
    bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes,
  );
};
const oid = (dotted: string) => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a! * 40 + b!];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
};
const time = (at: Date) =>
  der(
    0x18,
    Buffer.from(
      `${at
        .toISOString()
        .replace(/[-:T]|\.\d{3}/g, '')
        .slice(0, 14)}Z`,
    ),
  );
const name = (commonName: string) =>
  seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(commonName)))));

/**
 * A self-signed RSA certificate and its key (PEM), valid from `notBefore`
 * to `notAfter`: what an IdP publishes, and what `selfsigned` makes for
 * our SP keys.
 */
export function selfSignedCertificate(
  commonName: string,
  {
    keySize = 2048,
    notBefore = new Date(Date.now() - 2 * 86_400_000),
    notAfter = new Date(Date.now() + 2 * 365 * 86_400_000),
  }: { keySize?: number; notBefore?: Date; notAfter?: Date } = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: keySize,
  });
  const algorithm = seq(
    oid('1.2.840.113549.1.1.11'),
    der(0x05, Buffer.alloc(0)),
  );
  const tbs = seq(
    der(0xa0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    algorithm,
    name(commonName),
    seq(time(notBefore), time(notAfter)),
    name(commonName),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = seq(
    tbs,
    algorithm,
    der(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const pem = `-----BEGIN CERTIFICATE-----\n${certificate
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END CERTIFICATE-----\n`;
  new X509Certificate(pem); // fails loudly if the encoding is wrong
  return {
    private: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    cert: pem,
  };
}

/** `selfsigned`'s generate(), for vi.mock('selfsigned') while the package isn't installed. */
export const selfsignedStandIn = {
  generate: (
    attributes: { name: string; value: string }[],
    options: {
      keySize?: number;
      notBeforeDate?: Date;
      notAfterDate?: Date;
    } = {},
  ) =>
    Promise.resolve(
      selfSignedCertificate(attributes[0]?.value ?? 'test', {
        keySize: options.keySize,
        notBefore: options.notBeforeDate,
        notAfter: options.notAfterDate,
      }),
    ),
};

/** A path of this app from one of its absolute URLs (APP_URL has no port). */
export const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

/** A request as app.inject() takes it. */
type Injected = Parameters<NestNodeApplication['inject']>[0] & object;
/** What it answers. */
type InjectedResponse = Awaited<ReturnType<NestNodeApplication['inject']>>;

/**
 * A browser over `app.inject()`: keeps the cookies the responses set (a
 * `Max-Age=0` one removed) and sends them back, as a browser does across
 * the redirects of a sign-in.
 */
export function browser(app: NestNodeApplication): {
  jar: Map<string, string>;
  send(request: Injected): Promise<InjectedResponse>;
  get(url: string): Promise<InjectedResponse>;
} {
  const jar = new Map<string, string>();
  const keep = (setCookie: string | string[] | undefined) => {
    for (const line of [setCookie ?? []].flat()) {
      const [pair = '', ...attributes] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (!value || /max-age=0\b/i.test(attributes.join(';'))) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    }
  };
  const send = async (request: Injected): Promise<InjectedResponse> => {
    const cookie = [...jar]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    const response = await app.inject({
      ...request,
      headers: {
        ...(request.headers as Record<string, string> | undefined),
        ...(cookie && { cookie }),
      },
    } as never);
    keep(response.headers['set-cookie'] as string | string[] | undefined);
    return response;
  };
  return {
    jar,
    send,
    get: (url: string) => send({ method: 'GET', url }),
  };
}

/** DNS as the tests set it: TXT records by name. */
export function fakeDns() {
  const records = new Map<string, string[][]>();
  const resolver: TxtResolver = {
    resolveTxt: (name) => {
      const found = records.get(name);
      return found
        ? Promise.resolve(found)
        : Promise.reject(
            Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), {
              code: 'ENOTFOUND',
            }),
          );
    },
  };
  return { records, resolver };
}

/**
 * `domain` added and verified in the tenant of `headers` (an
 * administrator's): its TXT record published in the fake DNS, the check
 * run as the worker runs it.
 */
export async function verifyDomain(
  app: NestNodeApplication,
  dns: ReturnType<typeof fakeDns>,
  headers: Record<string, string>,
  tenantId: string,
  domain: string,
) {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/sso/domains',
    headers,
    payload: { domain },
  });
  if (created.statusCode !== 201) {
    throw new Error(`Domain not added: ${created.statusCode} ${created.body}`);
  }
  const body = created.json<{
    id: string;
    record: { name: string; value: string };
  }>();
  dns.records.set(body.record.name, [[body.record.value]]);
  const verify = await app.inject({
    method: 'POST',
    url: `/v1/sso/domains/${body.id}/verify`,
    headers,
  });
  if (verify.statusCode !== 202) {
    throw new Error(`Not verified: ${verify.statusCode} ${verify.body}`);
  }
  await app.get(SsoProcessor).run({
    kind: 'domain-verification',
    domainId: body.id,
    tenantId,
  });
  return body.id;
}

/** A SAML IdP: its signing key and certificate, made now. */
export function samlIdp(entityId = 'https://idp.acme.test/saml') {
  const pems = selfSignedCertificate('idp.acme.test');
  return { entityId, key: pems.private, cert: pems.cert };
}
export type SamlIdp = Awaited<ReturnType<typeof samlIdp>>;

const iso = (ms: number) => new Date(ms).toISOString();

/** What a test may vary in an IdP's response. */
export interface SamlResponseOptions {
  audience: string;
  acs: string;
  nameId: string;
  email?: string;
  inResponseTo?: string;
  assertionId?: string;
  notOnOrAfter?: number;
  issuer?: string;
  signWith?: { key: string; cert: string };
  tamper?: (signedAssertion: string) => string;
  /** More attributes (a group list: `{ groups: ['admins'] }`). */
  attributes?: Record<string, string[]>;
  /** Sign the Response around the assertion too (true: as the app requires). */
  signResponse?: boolean;
  /** Sign with RSA-SHA1 and SHA-1 digests (what the app refuses). */
  sha1?: boolean;
}

const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';

/** An enveloped signature (exclusive c14n) of the element `localName`, after its Issuer. */
function signElement(
  xml: string,
  localName: string,
  signer: { key: string; cert: string },
  sha1 = false,
) {
  const signature = new SignedXml({
    privateKey: signer.key,
    publicCert: signer.cert,
    signatureAlgorithm: sha1 ? RSA_SHA1 : RSA_SHA256,
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  signature.addReference({
    xpath: `/*[local-name(.)='${localName}']`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: sha1 ? SHA1 : SHA256,
  });
  signature.computeSignature(xml, {
    location: {
      reference: `/*[local-name(.)='${localName}']/*[local-name(.)='Issuer']`,
      action: 'after',
    },
  });
  return signature.getSignedXml();
}

/** The assertion, signed as an IdP signs it (enveloped, RSA-SHA256, exclusive c14n). */
function signedAssertion(idp: SamlIdp, options: SamlResponseOptions) {
  const now = Date.now();
  const issuer = options.issuer ?? idp.entityId;
  const notOnOrAfter = iso(options.notOnOrAfter ?? now + 5 * 60_000);
  const inResponseTo = options.inResponseTo
    ? ` InResponseTo="${options.inResponseTo}"`
    : '';
  const attributes = {
    ...(options.email && { email: [options.email] }),
    ...options.attributes,
  };
  const statement = Object.keys(attributes).length
    ? `<saml:AttributeStatement>${Object.entries(attributes)
        .map(
          ([name, values]) =>
            `<saml:Attribute Name="${name}">${values
              .map(
                (value) =>
                  `<saml:AttributeValue>${value}</saml:AttributeValue>`,
              )
              .join('')}</saml:Attribute>`,
        )
        .join('')}</saml:AttributeStatement>`
    : '';
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${options.assertionId ?? `_${randomUUID()}`}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${options.nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${inResponseTo} NotOnOrAfter="${notOnOrAfter}" Recipient="${options.acs}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${options.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now - 1000)}" SessionIndex="_${randomUUID()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    statement +
    `</saml:Assertion>`;
  let signed = signElement(
    assertion,
    'Assertion',
    options.signWith ?? idp,
    options.sha1,
  );
  if (options.tamper) {
    signed = options.tamper(signed);
  }
  return signed;
}

/** The Response around an assertion (plain or encrypted), signed unless asked not to. */
function wrapResponse(
  idp: SamlIdp,
  options: SamlResponseOptions,
  assertion: string,
) {
  const issuer = options.issuer ?? idp.entityId;
  const inResponseTo = options.inResponseTo
    ? ` InResponseTo="${options.inResponseTo}"`
    : '';
  let response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${iso(Date.now())}" Destination="${options.acs}"${inResponseTo}>` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    assertion +
    `</samlp:Response>`;
  if (options.signResponse ?? true) {
    response = signElement(
      response,
      'Response',
      options.signWith ?? idp,
      options.sha1,
    );
  }
  return Buffer.from(response).toString('base64');
}

/**
 * A SAML response as an IdP posts it: the assertion signed, in a Response
 * signed too (RSA-SHA256, exclusive c14n), unless the options say not to.
 */
export function samlResponse(idp: SamlIdp, options: SamlResponseOptions) {
  return wrapResponse(idp, options, signedAssertion(idp, options));
}

/**
 * The same with the signed assertion encrypted to our certificate (the
 * connection's `saml.spCertificate.pem`): AES-256-GCM, its key by RSA-OAEP.
 */
export async function encryptedSamlResponse(
  idp: SamlIdp,
  options: SamlResponseOptions,
  spCertificate: string,
  algorithms: {
    encryptionAlgorithm?: string;
    keyEncryptionAlgorithm?: string;
  } = {},
) {
  const encrypted = await new Promise<string>((resolve, reject) =>
    xmlenc.encrypt(
      signedAssertion(idp, options),
      {
        rsa_pub: new X509Certificate(spCertificate).publicKey.export({
          type: 'spki',
          format: 'pem',
        }),
        pem: spCertificate,
        encryptionAlgorithm:
          algorithms.encryptionAlgorithm ??
          'http://www.w3.org/2009/xmlenc11#aes256-gcm',
        keyEncryptionAlgorithm:
          algorithms.keyEncryptionAlgorithm ??
          'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
        // A test may encrypt as a weak IdP does, to see it refused.
        disallowEncryptionWithInsecureAlgorithm: false,
        warnInsecureAlgorithm: false,
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
  return wrapResponse(
    idp,
    options,
    `<saml:EncryptedAssertion>${encrypted}</saml:EncryptedAssertion>`,
  );
}

/** The AuthnRequest's ID in a redirect to the IdP (HTTP-Redirect binding: deflated, base64). */
export function authnRequestId(location: string) {
  const encoded = new URL(location).searchParams.get('SAMLRequest')!;
  const xml = inflateRawSync(Buffer.from(encoded, 'base64')).toString();
  return /\sID="([^"]+)"/.exec(xml)![1]!;
}

/**
 * An OpenID Connect provider on loopback: discovery, its JWKS, and a
 * token endpoint answering the codes a test plants (`issue()`), each with
 * the ID token's claims.
 */
export async function oidcIdp(clientId: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const codes = new Map<string, Record<string, unknown>>();
  const tokenRequests: URLSearchParams[] = [];
  let issuer = '';
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/jwks') {
      return json(200, {
        keys: [
          {
            ...publicKey.export({ format: 'jwk' }),
            kid: 'k1',
            alg: 'RS256',
            use: 'sig',
          },
        ],
      });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        tokenRequests.push(form);
        const claims = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!claims) {
          return json(400, { error: 'invalid_grant' });
        }
        json(200, {
          access_token: randomUUID(),
          token_type: 'Bearer',
          expires_in: 300,
          id_token: jwt(privateKey, claims),
        });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get issuer() {
      return issuer;
    },
    tokenRequests,
    /** A code for the authorization request at `location`: its ID token carries these claims (and the request's nonce, unless given). */
    issue(location: string, claims: Record<string, unknown>) {
      const params = new URL(location).searchParams;
      const now = Math.floor(Date.now() / 1000);
      const code = randomUUID();
      codes.set(code, {
        iss: issuer,
        aud: clientId,
        iat: now,
        exp: now + 300,
        nonce: params.get('nonce'),
        ...claims,
      });
      return { code, state: params.get('state')! };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function jwt(key: KeyObject, claims: Record<string, unknown>) {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${part({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${part(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`;
}

/** What the OAuth 2.0 provider's user-info endpoint answers for a code's token. */
export interface UserinfoAnswer {
  /** JSON (the default: `{}`). */
  body?: unknown;
  /** Sent as is, instead of `body`'s JSON (malformed JSON). */
  raw?: string;
  status?: number;
  /** A redirect to this path of the provider (never to be followed). */
  redirect?: string;
}

/**
 * A plain OAuth 2.0 provider on loopback, shaped like Lark/Feishu v2 (no
 * discovery, no ID token): `/authorize`, an RFC 6749 token endpoint answering
 * the codes a test plants (`issue()`), and `/user_info` answering, for that
 * code's access token, what the test said. `/elsewhere` counts the requests
 * a redirect would lead to.
 */
export async function oauth2Idp() {
  const codes = new Map<string, UserinfoAnswer>();
  const tokens = new Map<string, UserinfoAnswer>();
  const tokenRequests: { form: URLSearchParams; authorization?: string }[] = [];
  const userinfoRequests: { authorization?: string }[] = [];
  let elsewhere = 0;
  let base = '';
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        tokenRequests.push({ form, authorization: req.headers.authorization });
        const answer = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!answer || !form.get('code_verifier')) {
          return json(400, {
            code: 20003,
            error: 'invalid_grant',
            error_description: 'The code is invalid.',
          });
        }
        const accessToken = randomUUID();
        tokens.set(accessToken, answer);
        // Lark's v2 token answer: its own `code` beside RFC 6749's fields.
        json(200, {
          code: 0,
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 7200,
          refresh_token: randomUUID(),
          scope: '',
        });
      });
      return;
    }
    if (url.pathname === '/user_info' && req.method === 'GET') {
      userinfoRequests.push({ authorization: req.headers.authorization });
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const answer = token ? tokens.get(token) : undefined;
      if (!answer) {
        return json(401, { code: 99991663, msg: 'invalid access token' });
      }
      if (answer.redirect) {
        res.writeHead(302, { location: `${base}${answer.redirect}` });
        return res.end();
      }
      if (answer.raw !== undefined) {
        res.writeHead(answer.status ?? 200, {
          'content-type': 'application/json',
        });
        return res.end(answer.raw);
      }
      return json(answer.status ?? 200, answer.body ?? {});
    }
    if (url.pathname.startsWith('/elsewhere')) {
      elsewhere += 1;
      return json(200, { code: 0, data: { open_id: 'someone-else' } });
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get base() {
      return base;
    },
    /** The connection's endpoints at this provider. */
    get endpoints() {
      return {
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
        userinfoEndpoint: `${base}/user_info`,
      };
    },
    tokenRequests,
    userinfoRequests,
    get elsewhere() {
      return elsewhere;
    },
    /** A code for the authorization request at `location`, whose user info answers `answer`. */
    issue(location: string, answer: UserinfoAnswer) {
      const code = randomUUID();
      codes.set(code, answer);
      return { code, state: new URL(location).searchParams.get('state')! };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A Lark `user_info` answer (`{ code, msg, data }`) for this person. */
export function larkUser(
  data: Record<string, unknown>,
  code = 0,
): UserinfoAnswer {
  return {
    body: {
      code,
      msg: code === 0 ? 'success' : 'failed',
      data: {
        union_id: `on_${randomUUID().slice(0, 8)}`,
        tenant_key: 'tenant-key',
        name: 'Lark Person',
        avatar_url: 'https://example.com/avatar.png',
        ...data,
      },
    },
  };
}
