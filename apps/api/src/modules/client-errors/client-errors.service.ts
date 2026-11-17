import { Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import type { clientErrorReportSchema } from './client-errors.schemas.js';

type ClientErrorReport = z.infer<typeof clientErrorReportSchema>;

/**
 * Logs a web app's unexpected error at `error`, so it reaches the same place
 * as every server-side one: the request id correlates it with the access
 * log, and the redaction (core/logging) keeps a pasted secret out of the
 * message or the stack. Nothing is stored beyond the log.
 */
@Injectable()
export class ClientErrorsService {
  private readonly logger = new Logger(ClientErrorsService.name);

  report(report: ClientErrorReport) {
    this.logger.error(
      `[${report.id}] ${report.source} error on ${report.path}: ${report.message}`,
      report.stack,
    );
  }
}
