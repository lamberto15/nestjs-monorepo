import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Header,
  Headers,
  Injectable,
  Ip,
  NotFoundException,
  Post,
  Query,
  Redirect,
  Req,
  Res,
  UseGuards,
  Body,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Public } from '@nestjs/authentication';
import { Throttle, minutes } from '@nestjs/throttler';
import {
  ApiFoundResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type {
  NodeRequest as Request,
  NodeResponse as Response,
} from '@nestjs/platform-node';
import { ClsServiceManager } from 'nestjs-cls';
import type { z } from 'zod';
import { TENANT_SCOPE, tenantScope } from '../../core/tenancy/tenant-scope.js';
import { authConfig } from '../auth/auth.config.js';
import { SSO_HANDOFF_TTL_MS, ssoCookie } from './sso-browser.js';
import {
  samlAcsBodySchema,
  ssoCallbackQuerySchema,
  ssoLoginQuerySchema,
} from './sso.schemas.js';
import { SsoSignIn } from './sso-sign-in.service.js';
import {
  type SsoConnection,
  SsoConnectionsService,
} from './sso-connections.service.js';
import { AllowInMaintenance } from '../../core/http/maintenance.js';

const CONNECTION = Symbol('sso-connection');

/**
 * The enabled connection in the URL (`:tenantId/:connectionId`), found in
 * its tenant's scope, and the rest of the request in that tenant (as an
 * incoming webhook of a tenant is). An unknown tenant or connection, or one
 * that is off: 404, whichever it is.
 */
@Injectable()
export class SsoConnectionGuard implements CanActivate {
  constructor(private readonly connections: SsoConnectionsService) {}

  async canActivate(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<Request & { [CONNECTION]?: SsoConnection }>();
    const { tenantId, connectionId } = request.params as Record<
      string,
      string | undefined
    >;
    const connection =
      tenantId && connectionId
        ? await this.connections.resolveEnabled(tenantId, connectionId)
        : null;
    if (!connection) {
      throw new NotFoundException('No such SSO connection.');
    }
    request[CONNECTION] = connection;
    ClsServiceManager.getClsService().set(
      TENANT_SCOPE,
      tenantScope(connection.tenantId),
    );
    return true;
  }
}

const connectionOf = (request: Request) =>
  (request as Request & { [CONNECTION]: SsoConnection })[CONNECTION];

/**
 * Signing in through a tenant's SSO connection (README.md). The browser navigates to `login`; the IdP sends it back to the
 * OIDC or OAuth 2.0 callback, or POSTs its SAML response to the ACS, which hands over to
 * `saml/complete`. Every outcome lands on the web app: its `redirectTo`
 * when signed in, else its root with `?error=sso_failed` (why is in the
 * tenant's audit log, never in the URL).
 */
@ApiTags('auth')
@AllowInMaintenance()
@Public()
@UseGuards(SsoConnectionGuard)
@Controller('auth/sso/:tenantId/:connectionId')
export class SsoAuthController {
  constructor(
    private readonly signIn: SsoSignIn,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
  ) {}

  @Throttle({ default: { limit: 30, ttl: minutes(1) } })
  @Get('login')
  @Redirect()
  @ApiOperation({
    summary:
      "Start signing in with the tenant's identity provider (navigate the browser here)",
  })
  @ApiFoundResponse({
    description:
      'To the IdP; an OpenID Connect connection whose discovery document has not arrived yet: to the web app with `?error=sso_unavailable`.',
  })
  @ApiNotFoundResponse({
    description: 'No such tenant or connection, or it is off.',
  })
  async login(
    @Req() request: Request,
    @Query({ schema: ssoLoginQuerySchema })
    { redirectTo }: z.infer<typeof ssoLoginQuerySchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { url, binding } = await this.signIn.start(
      connectionOf(request),
      redirectTo,
    );
    if (binding !== undefined) {
      res.append('Set-Cookie', this.cookie().set(binding));
    }
    return { url };
  }

  @Get('oidc/callback')
  @Redirect()
  @ApiOperation({
    summary: 'Where an OpenID Connect IdP sends the browser back',
  })
  @ApiFoundResponse({
    description:
      'To the web app: signed in, or `?error=sso_failed` (the reason is audited).',
  })
  @ApiNotFoundResponse({
    description:
      'No such tenant or connection, it is off, or it is not an OpenID Connect connection.',
  })
  oidcCallback(
    @Req() request: Request,
    @Query({ schema: ssoCallbackQuerySchema })
    query: z.infer<typeof ssoCallbackQuerySchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.codeCallback('oidc', request, query, ip, userAgent, res);
  }

  @Get('oauth2/callback')
  @Redirect()
  @ApiOperation({
    summary: 'Where an OAuth 2.0 provider sends the browser back',
  })
  @ApiFoundResponse({
    description:
      'To the web app: signed in, or `?error=sso_failed` (the reason is audited).',
  })
  @ApiNotFoundResponse({
    description:
      'No such tenant or connection, it is off, or it is not an OAuth 2.0 connection.',
  })
  oauth2Callback(
    @Req() request: Request,
    @Query({ schema: ssoCallbackQuerySchema })
    query: z.infer<typeof ssoCallbackQuerySchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.codeCallback('oauth2', request, query, ip, userAgent, res);
  }

  /** The authorization code flow's return, to the connection's own protocol only; the cookie is spent whatever the outcome. */
  private async codeCallback(
    protocol: 'oidc' | 'oauth2',
    request: Request,
    query: z.infer<typeof ssoCallbackQuerySchema>,
    ip: string,
    userAgent: string | undefined,
    res: Response,
  ) {
    const connection = connectionOf(request);
    if (connection.protocol !== protocol) {
      throw new NotFoundException(`Not an ${protocol} connection.`);
    }
    const cookie = this.cookie();
    res.append('Set-Cookie', cookie.clear());
    return {
      url: await this.signIn.finishCode(
        protocol,
        connection,
        query,
        cookie.read(request.headers.cookie),
        { ip, userAgent },
      ),
    };
  }

  @Throttle({ default: { limit: 30, ttl: minutes(1) } })
  @Post('saml/acs')
  @Redirect(undefined, 303)
  @ApiOperation({
    summary:
      'The assertion consumer service: where a SAML IdP POSTs its response',
    description:
      'A form post (`application/x-www-form-urlencoded`, `SAMLResponse`), cross-site by nature: exempt from the CSRF check, which the browser binding (its cookie) and `InResponseTo` replace.',
  })
  @ApiResponse({
    status: 303,
    description:
      'To `saml/complete`, which signs the browser in; or to the web app with `?error=sso_failed`.',
  })
  async acs(
    @Req() request: Request,
    @Body({ schema: samlAcsBodySchema })
    body: z.infer<typeof samlAcsBodySchema>,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookie = this.cookie();
    const { url, binding, failed } = await this.signIn.consumeSaml(
      connectionOf(request),
      body.SAMLResponse,
      cookie.read(request.headers.cookie),
      ip,
      request.params as { tenantId: string; connectionId: string },
    );
    if (binding) {
      res.append('Set-Cookie', cookie.set(binding, SSO_HANDOFF_TTL_MS));
    }
    if (failed) {
      res.append('Set-Cookie', cookie.clear());
    }
    return { url };
  }

  @Get('saml/complete')
  @Redirect()
  @ApiOperation({
    summary: 'Signs the browser in once the ACS checked the SAML response',
  })
  @ApiFoundResponse({
    description: 'To the web app: signed in, or `?error=sso_failed`.',
  })
  async samlComplete(
    @Req() request: Request,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookie = this.cookie();
    res.append('Set-Cookie', cookie.clear());
    return {
      url: await this.signIn.completeSaml(
        connectionOf(request),
        cookie.read(request.headers.cookie),
        { ip, userAgent },
      ),
    };
  }

  @Get('saml/metadata')
  @Header('Content-Type', 'application/samlmetadata+xml; charset=utf-8')
  @ApiOperation({
    summary: "Our SAML service provider's metadata, for the IdP",
    description:
      'The entity id (this URL), the assertion consumer service, and that assertions must be signed. A document for the IdP to import, not a page.',
  })
  @ApiProduces('application/samlmetadata+xml')
  @ApiOkResponse({ description: 'SAML 2.0 metadata (XML).' })
  @ApiNotFoundResponse({
    description:
      'No such tenant or connection, it is off, or it is not a SAML connection.',
  })
  samlMetadata(@Req() request: Request) {
    return this.signIn.samlMetadata(connectionOf(request));
  }

  /** Secure (and `__Host-`) as the session's cookie (SESSION_COOKIE_SECURE). */
  private cookie() {
    return ssoCookie(this.auth.sessionCookieSecure);
  }
}
