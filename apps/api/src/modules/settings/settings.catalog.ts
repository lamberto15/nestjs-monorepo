import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { NotFoundException } from '@nestjs/common';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import {
  type SettingValueSchema,
  settingValueSchema,
} from './settings.value-schema.js';
import type { SettingDeclaration } from './settings.types.js';

/** Ids of registered lists: what Nest hashes for each forFeature() module. */
const ids = new WeakMap<object, number>();
let lastId = 0;

/**
 * One module's declarations, as `SettingsModule.forFeature()` provides them
 * in that module; the catalog discovers every one. Serialized as a number:
 * Nest hashes a dynamic module's providers, and a declaration holds a Zod
 * schema.
 */
export class SettingsRegistration {
  constructor(readonly declarations: readonly SettingDeclaration<any>[]) {
    if (!ids.has(declarations)) ids.set(declarations, ++lastId);
  }

  toJSON() {
    return `settings#${ids.get(this.declarations)}`;
  }
}

/**
 * What was registered: every module's settings, in the order the modules
 * were found, each with the value schema derived from its Zod schema. Refuses
 * at startup a key declared twice, a default its own schema refuses, and a
 * secret without encryption keys.
 */
@Injectable()
export class SettingsCatalog implements OnModuleInit {
  private readonly byKey = new Map<
    string,
    { declaration: SettingDeclaration<any>; valueSchema: SettingValueSchema }
  >();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly encryption: EncryptionService,
  ) {}

  onModuleInit() {
    const found = new Set<readonly SettingDeclaration<any>[]>();
    for (const wrapper of this.discovery.getProviders()) {
      if (wrapper.instance instanceof SettingsRegistration) {
        found.add(wrapper.instance.declarations);
      }
    }
    for (const declaration of [...found].flat()) {
      if (this.byKey.has(declaration.key)) {
        throw new Error(`Setting "${declaration.key}" is declared twice.`);
      }
      if (!declaration.schema.safeParse(declaration.default).success) {
        throw new Error(
          `Setting "${declaration.key}": its default does not pass its schema.`,
        );
      }
      if (declaration.secret && !this.encryption.currentKeyId) {
        throw new Error(
          `Setting "${declaration.key}" is a secret: set DATA_ENCRYPTION_KEYS.`,
        );
      }
      this.byKey.set(declaration.key, {
        declaration,
        valueSchema: settingValueSchema(declaration.schema),
      });
    }
  }

  /** The declared settings, in declaration order. */
  declarations() {
    return [...this.byKey.values()].map((entry) => entry.declaration);
  }

  /** A declared setting, or a 404. */
  declaration(key: string): SettingDeclaration<any> {
    const entry = this.byKey.get(key);
    if (!entry) {
      throw new NotFoundException(`No setting "${key}".`);
    }
    return entry.declaration;
  }

  valueSchema(key: string): SettingValueSchema {
    return this.byKey.get(key)!.valueSchema;
  }
}
