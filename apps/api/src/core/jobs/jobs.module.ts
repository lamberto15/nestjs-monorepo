import { Module } from '@nestjs/common';
import { JobIndex } from './job-index.js';

/** Who queued which long jobs (exports, imports, bulk runs): their lists. Needs RedisModule (global). */
@Module({ providers: [JobIndex], exports: [JobIndex] })
export class JobsModule {}
