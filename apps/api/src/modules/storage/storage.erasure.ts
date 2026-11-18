import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import {
  TENANT_EVENTS,
  type TenantErasingEvent,
} from '../../iam/tenants/tenants.events.js';
import { StoredFiles } from './storage.release.js';

/**
 * What is erased takes its files: every file under the tenant's prefix with
 * the tenant, every file under the account's (its picture, its data
 * exports) with the account. Released in the erase's transaction, deleted
 * after its commit (StoredFiles): an erase that rolls back keeps them.
 */
@PersonalData({ name: 'account-files', scopes: ['account'] })
@Injectable()
export class StorageErasure implements PersonalDataSection {
  constructor(private readonly files: StoredFiles) {}

  /** In TenantsService.purge()'s transaction; an error stops the erase. */
  @OnEvent(TENANT_EVENTS.erasing, { suppressErrors: false })
  async tenantErasing({ tenantId }: TenantErasingEvent) {
    await this.files.releaseTenant(tenantId);
  }

  async erase({ userId }: PersonalDataSubject) {
    await this.files.releaseAccount(userId);
  }
}
