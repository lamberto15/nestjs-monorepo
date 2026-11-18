import { Module } from '@nestjs/common';
import { ProblemDetailsFilter } from '../http/problem-details.filter.js';
import { logHooks } from '../logging/logging.js';
import { nestrixModule } from './nestrix.js';
import { observeModule } from './observe.js';
import { reportError } from './report-error.js';
import { countObserveRefusal } from './telemetry-health.js';
import { traceCorrelation } from './trace-correlation.js';

// Trace ids on log lines, refused uploads counted, and the 5xx errors the
// filter answers reported: hooks of core/logging and core/http, so neither
// knows this module.
logHooks.correlation = traceCorrelation;
logHooks.problem = countObserveRefusal;
ProblemDetailsFilter.onServerError(reportError);

/**
 * Production telemetry, off until a backend's variables are set. Two
 * backends, swapped by configuration alone: NestJS Observe (hosted:
 * OBSERVE_APP_KEY, OBSERVE_APP_SECRET) or Nestrix, self-hosted over
 * OpenTelemetry (OTEL_EXPORTER_OTLP_ENDPOINT). Imported before the modules
 * that register global interceptors, so Nestrix sees their exceptions.
 */
@Module({ imports: [nestrixModule(), observeModule()] })
export class ObservabilityModule {}
