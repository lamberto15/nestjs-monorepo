import { Public } from '@nestjs/authentication';
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { minutes, Throttle } from '@nestjs/throttler';
import type { z } from 'zod';
import { clientErrorReportSchema } from './client-errors.schemas.js';
import { ClientErrorsService } from './client-errors.service.js';

/**
 * `POST /v1/client-errors`, where the web app sends an error it did not
 * expect. Public: the error can happen before sign-in (the sign-in page
 * itself), and the answer tells nothing about an account either way. The
 * limit is per address and sits under the web app's own (20 a minute per
 * tab), so a loop cannot flood the log.
 */
@ApiTags('client errors')
@Public()
@Controller('client-errors')
export class ClientErrorsController {
  constructor(private readonly clientErrors: ClientErrorsService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 120, ttl: minutes(1) } })
  @ApiOperation({
    summary: 'Report a web app error it did not expect',
    description:
      'The report id shown to the user, where it was heard, its message and stack, and the route. Logged, never stored.',
  })
  @ApiNoContentResponse({ description: 'Logged.' })
  report(
    @Body({ schema: clientErrorReportSchema })
    report: z.infer<typeof clientErrorReportSchema>,
  ) {
    this.clientErrors.report(report);
  }
}
