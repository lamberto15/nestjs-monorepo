import { InjectTransaction } from '@nestjs-cls/transactional';
import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Injectable,
  Module,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { Database } from '../../src/core/database/database.js';
import { Tenancy } from '../../src/core/tenancy/tenancy.service.js';
import { tenantItems } from './tenant-items.tables.js';

/** Reads and writes tenant items as every service does: no tenant in any query. */
@Injectable()
export class TenantItemsService {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async add(name: string, parentId?: string) {
    const [row] = await this.db
      .insert(tenantItems)
      .values({ name, parentId })
      .returning();
    return row!;
  }

  /** Every row the scope sees: a query with no where clause. */
  async names() {
    const rows = await this.db
      .select({ name: tenantItems.name })
      .from(tenantItems)
      .orderBy(tenantItems.name);
    return rows.map((row) => row.name);
  }
}

/**
 * The test's stand-in for sign-in: the tenant a request names in a header
 * (a real guard takes it from the principal), entered before the handler.
 */
@Injectable()
export class TestTenantGuard implements CanActivate {
  constructor(private readonly tenancy: Tenancy) {}

  canActivate(context: ExecutionContext) {
    const tenantId = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
    }>().headers['x-test-tenant'];
    if (tenantId) {
      this.tenancy.enter(tenantId);
    }
    return true;
  }
}

@Controller('tenant-items')
@UseGuards(TestTenantGuard)
export class TenantItemsController {
  constructor(private readonly items: TenantItemsService) {}

  @Get()
  async list() {
    return { names: await this.items.names() };
  }

  @Post()
  add(@Body() body: { name: string }) {
    return this.items.add(body.name);
  }
}

@Module({
  controllers: [TenantItemsController],
  providers: [TenantItemsService, TestTenantGuard],
  exports: [TenantItemsService],
})
export class TenantItemsModule {}
