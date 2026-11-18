import { Module } from '@nestjs/common';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { OrganizationModule } from '../../iam/organization/organization.module.js';
import { ListsModule } from '../lists/lists.module.js';
import { RecordsModule } from '../records/records.module.js';
import { ViewsController } from './views.controller.js';
import { VIEW_PERMISSIONS } from './views.permissions.js';
import { ViewsService } from './views.service.js';
import { ViewsPersonalData } from './views.personal-data.js';

/** Saved views of any list (README.md). */
@Module({
  imports: [
    AccessModule.forFeature(VIEW_PERMISSIONS),
    AuditModule,
    OrganizationModule,
    ListsModule,
    RecordsModule,
  ],
  controllers: [ViewsController],
  providers: [ViewsService, ViewsPersonalData],
  // Favorites pin a view only while its owner sees it (modules/favorites).
  exports: [ViewsService],
})
export class ViewsModule {}
