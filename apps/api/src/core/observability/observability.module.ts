import { Module } from '@nestjs/common';
import { ProblemDetailsFilter } from '../http/problem-details.filter.js';
import { logHooks } from '../logging/logging.js';
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
 * OBSERVE_APP_KEY, OBSERVE_APP_SECRET), registered here, or a self-hosted
 * OpenTelemetry backend such as the Nestrix server
 * (OTEL_EXPORTER_OTLP_ENDPOINT), started in instrument.ts before the app
 * loads.
 */
@Module({ imports: [observeModule()] })
export class ObservabilityModule {}
