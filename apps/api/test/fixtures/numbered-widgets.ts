import { TransactionHost } from '@nestjs-cls/transactional';
import { Body, Controller, Module, Post } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import { z } from 'zod';
import { NamingSeriesService } from '../../src/modules/sequences/naming-series.service.js';
import { SequencesModule } from '../../src/modules/sequences/sequences.module.js';
import { SequencesService } from '../../src/modules/sequences/sequences.service.js';
import type { DatabaseTransactions } from '../../src/core/database/database.js';

/**
 * A numbered subject for e2e tests, as a module that numbers its records
 * writes it: it registers `Widget` with SequencesModule.forFeature() and
 * takes a number in the transaction of its own create. `POST /widgets`
 * numbers through naming series; `POST /plain-widgets` through the
 * SequencesService alone, to see a rolled back write leave no gap.
 */
const body = z.object({
  title: z.string().optional(),
  code: z.string().optional(),
  publishedAt: z.iso.datetime().optional(),
  namingSeriesId: z.uuid().optional(),
  fail: z.boolean().optional(),
});

@Controller('widgets')
class WidgetsController {
  constructor(
    private readonly series: NamingSeriesService,
    private readonly sequences: SequencesService,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
  ) {}

  @Post()
  @Can.Anyone()
  create(@Body({ schema: body }) dto: z.infer<typeof body>) {
    return this.txHost.withTransaction(async () => {
      const { formatted } = await this.series.next('Widget', {
        seriesId: dto.namingSeriesId,
        values: dto,
      });
      if (dto.fail) throw new Error('changed my mind');
      return { number: formatted };
    });
  }

  @Post('plain')
  @Can.Anyone()
  plain(@Body({ schema: body }) dto: z.infer<typeof body>) {
    return this.txHost.withTransaction(async () => {
      const { formatted } = await this.sequences.next('plain-widget', {
        prefix: 'PW',
        perYear: true,
        width: 3,
      });
      if (dto.fail) throw new Error('changed my mind');
      return { number: formatted };
    });
  }
}

@Module({
  imports: [
    SequencesModule.forFeature({
      subjects: [
        {
          subject: 'Widget',
          sequence: 'widget',
          declared: { prefix: 'WG', perYear: true, width: 5 },
          fields: { title: 'text', code: 'text', publishedAt: 'datetime' },
        },
      ],
    }),
  ],
  controllers: [WidgetsController],
})
export class NumberedWidgetsModule {}
