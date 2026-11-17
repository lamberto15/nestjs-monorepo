import { Module } from '@nestjs/common';
import { ClientErrorsController } from './client-errors.controller.js';
import { ClientErrorsService } from './client-errors.service.js';

/** The web app's error reports: one route, logged, nothing stored. See README.md. */
@Module({
  controllers: [ClientErrorsController],
  providers: [ClientErrorsService],
})
export class ClientErrorsModule {}
