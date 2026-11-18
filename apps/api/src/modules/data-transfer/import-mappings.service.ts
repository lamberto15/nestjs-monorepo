import { InjectTransaction, Transactional } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import {
  type CreateImportMappingDto,
  MAX_MAPPINGS_PER_IMPORT,
} from './data-transfer.schemas.js';
import { DataTransferService } from './data-transfer.service.js';
import { mappingProblems, staleTargets } from './import-mapping.js';
import {
  type ImportMappingRow,
  importMappings,
} from './import-mappings.tables.js';

const item = (row: ImportMappingRow, stale: string[]) => ({
  id: row.id,
  importer: row.importer,
  name: row.name,
  mapping: row.mapping,
  stale,
  createdAt: row.createdAt.toISOString(),
});

/**
 * The tenant's saved column mappings of an import. Whoever may run the
 * import may read, save and delete them (a 404 otherwise, as for its
 * template). Every read says which targets are stale for the caller; a save
 * is refused as the import would be. Audited `importMapping.created`,
 * `importMapping.deleted`.
 */
@Injectable()
export class ImportMappingsService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly transfers: DataTransferService,
    private readonly audit: AuditService,
  ) {}

  async list(principal: RequestPrincipal, importer: string) {
    const columns = await this.transfers.mappableColumns(principal, importer);
    const rows = await this.db
      .select()
      .from(importMappings)
      .where(eq(importMappings.importer, importer))
      .orderBy(asc(importMappings.name));
    return {
      items: rows.map((row) => item(row, staleTargets(row.mapping, columns))),
    };
  }

  @Transactional()
  async create(
    principal: RequestPrincipal,
    importer: string,
    dto: CreateImportMappingDto,
    ip?: string,
  ) {
    const columns = await this.transfers.mappableColumns(principal, importer);
    const problems = mappingProblems(dto.mapping, columns);
    if (problems.length) throw new BadRequestException(problems.join(' '));
    const [{ total } = { total: 0 }] = await this.db
      .select({ total: count() })
      .from(importMappings)
      .where(eq(importMappings.importer, importer));
    if (total >= MAX_MAPPINGS_PER_IMPORT) {
      throw new BadRequestException(
        `At most ${MAX_MAPPINGS_PER_IMPORT} saved mappings per import: delete one first.`,
      );
    }
    const [created] = await this.db
      .insert(importMappings)
      .values({ importer, name: dto.name, mapping: dto.mapping })
      .returning()
      .catch((error: unknown) => {
        if (databaseErrorKind(error) === 'unique_violation') {
          throw new ConflictException({
            code: 'import_mapping_taken',
            message: `A mapping named "${dto.name}" exists for this import.`,
          });
        }
        throw error;
      });
    await this.audit.record(principal, {
      action: 'importMapping.created',
      targetType: 'importMapping',
      targetId: created!.id,
      details: { importer, name: dto.name },
      ip,
    });
    return item(created!, []);
  }

  @Transactional()
  async remove(
    principal: RequestPrincipal,
    importer: string,
    id: string,
    ip?: string,
  ) {
    await this.transfers.mappableColumns(principal, importer);
    const [deleted] = await this.db
      .delete(importMappings)
      .where(
        and(eq(importMappings.id, id), eq(importMappings.importer, importer)),
      )
      .returning();
    if (!deleted) throw new NotFoundException(`Mapping ${id} not found.`);
    await this.audit.record(principal, {
      action: 'importMapping.deleted',
      targetType: 'importMapping',
      targetId: id,
      details: { importer, name: deleted.name },
      ip,
    });
  }
}
