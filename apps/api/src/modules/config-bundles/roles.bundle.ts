import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PermissionCatalog } from '../../iam/access/permission-catalog.js';
import { isAll } from '../../iam/access/permissions.js';
import { RolesService } from '../../iam/access/roles.service.js';
import {
  type BundleSectionHandler,
  BundleSection,
  type SectionPreview,
} from './config-bundles.sections.js';
import { canonicalJson } from './config-bundles.service.js';

const permissionSchema = z.object({
  subject: z.string().min(1),
  action: z.string().min(1),
  conditions: z
    .array(
      z.object({
        key: z.string().min(1),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(10),
  fields: z.array(z.string().min(1)).max(50).optional(),
});

export const rolesContentsSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(80),
      description: z.string().max(500),
      permissions: z.array(permissionSchema).max(100),
    }),
  )
  .max(200);
type Roles = z.infer<typeof rolesContentsSchema>;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The tenant's custom roles, by name, with their permissions. The built-in
 * Administrator role stays out (it is never changed), and so do grants to
 * people. Roles are made and changed through RolesService: nobody grants
 * in a bundle what they could not grant by hand.
 */
@BundleSection('roles')
@Injectable()
export class RolesBundle implements BundleSectionHandler<Roles> {
  readonly schema = rolesContentsSchema;

  constructor(
    private readonly roles: RolesService,
    private readonly catalog: PermissionCatalog,
  ) {}

  async export(): Promise<Roles> {
    return (await this.roles.list())
      .filter((role) => !role.system)
      .map(({ name, description, permissions }) => ({
        name,
        description,
        permissions,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async preview(roles: Roles): Promise<SectionPreview> {
    const target = await this.roles.list();
    const errors: NonNullable<SectionPreview['errors']> = [];
    const warnings: NonNullable<SectionPreview['warnings']> = [];
    const changes: SectionPreview['changes'] = [];
    for (const role of roles) {
      const own = target.find((candidate) => candidate.name === role.name);
      if (own?.system) {
        errors.push({
          ref: role.name,
          message: 'A built-in role of the target: it is never changed.',
        });
        continue;
      }
      for (const permission of role.permissions) {
        if (isAll(permission)) continue;
        const result = this.catalog.validate(permission);
        if (!result.ok) {
          errors.push({ ref: role.name, message: result.error });
        } else if (
          permission.conditions.some((condition) =>
            UUID.test(JSON.stringify(condition.params ?? {})),
          )
        ) {
          warnings.push({
            ref: role.name,
            message: `${permission.subject}.${permission.action}: a condition names a record of the source environment by id; check it after applying.`,
          });
        }
      }
      changes.push({
        ref: role.name,
        action: !own
          ? 'create'
          : canonicalJson(shape(own)) === canonicalJson(role)
            ? 'unchanged'
            : 'update',
      });
    }
    const names = new Set(roles.map((role) => role.name));
    return {
      errors,
      warnings,
      changes,
      touched: target.filter((role) => names.has(role.name)).map(shape),
    };
  }

  async import(
    actor: Parameters<RolesService['create']>[0],
    roles: Roles,
    { changes, ip }: { changes: SectionPreview['changes']; ip?: string },
  ) {
    const target = await this.roles.list();
    for (const role of roles) {
      const action = changes.find((change) => change.ref === role.name)?.action;
      if (action === 'unchanged') continue;
      const input = {
        name: role.name,
        description: role.description,
        permissions: role.permissions,
      };
      const own = target.find((candidate) => candidate.name === role.name);
      if (own) {
        await this.roles.update(actor, own.id, input, ip);
      } else {
        await this.roles.create(actor, input, ip);
      }
    }
  }
}

/** A role as the bundle holds it. */
const shape = ({
  name,
  description,
  permissions,
}: {
  name: string;
  description: string;
  permissions: Roles[number]['permissions'];
}) => ({ name, description, permissions });
