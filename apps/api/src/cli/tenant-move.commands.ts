import { readFile } from 'node:fs/promises';
import { HttpException, Injectable } from '@nestjs/common';
import {
  Command,
  CommandRunner,
  InquirerService,
  Option,
  Question,
  QuestionSet,
} from 'nest-commander';
import { SystemContext } from '../iam/access/system-context.js';
import type { Manifest } from '../modules/tenant-move/move-archive.js';
import {
  MoveRefused,
  TenantMoveService,
} from '../modules/tenant-move/tenant-move.service.js';
import { Accounts } from './accounts.service.js';
import { OPS_JOB } from './cli.jobs.js';
import { carryOut, type ChangeOptions, YES } from './commands.js';
import { Confirmer } from './confirm.js';
import { by, CliError } from './plan.js';

/**
 * Moving a tenant to a server of its own (modules/tenant-move): freeze,
 * export on the source, import on the target, then erase it on the source.
 * Every step is a plan, shown and confirmed, run as `system:ops`.
 */

interface MoveOptions extends ChangeOptions {
  out?: string;
  keyFile?: string;
  eraseAccounts?: boolean;
}

/** The archive key, asked without echo when no file gives it. */
@QuestionSet({ name: 'tenant-move-key' })
export class ArchiveKeyQuestion {
  @Question({
    type: 'password',
    name: 'key',
    message: 'Archive key (tmk1.…):',
    mask: '*',
  })
  parseKey(value: string) {
    return value;
  }
}

/** A refusal of the move's service, or an HTTP one of a service it calls, as the terminal shows it. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof MoveRefused) throw new CliError(error.message);
    if (error instanceof HttpException) throw new CliError(error.message);
    throw error;
  }
}

const sharedLines = (accounts: Manifest['accounts']) =>
  accounts
    .filter((account) => account.elsewhere.length > 0)
    .map(
      (account) =>
        `  ${account.email.padEnd(36)} also in ${account.elsewhere.join(', ')}`,
    );

@Injectable()
abstract class Moving extends CommandRunner {
  constructor(
    protected readonly accounts: Accounts,
    protected readonly moves: TenantMoveService,
    protected readonly confirmer: Confirmer,
    protected readonly system: SystemContext,
  ) {
    super();
  }

  protected get actor() {
    return this.system.principal(OPS_JOB);
  }

  @Option(YES) parseYes() {
    return true;
  }
}

@Command({
  name: 'tenant:freeze',
  arguments: '<tenant>',
  description:
    'Make a tenant read only for everyone and every job (before its move); tenant:thaw undoes it',
})
@Injectable()
export class TenantFreezeCommand extends Moving {
  async run([ref]: string[], options: MoveOptions) {
    const tenant = await this.accounts.tenant(ref!);
    const { changed } = await refusing(() =>
      carryOut(
        this.confirmer,
        {
          summary: [
            `Freeze "${tenant.slug}": read only for everyone and every job from now on (reading still works), until tenant:thaw ${tenant.slug}.`,
          ],
          apply: (operator) =>
            this.moves.freeze(this.actor, tenant.id, true, by(operator)),
        },
        options,
      ),
    );
    console.log(
      changed
        ? `"${tenant.slug}" is frozen.`
        : `"${tenant.slug}" was frozen already.`,
    );
  }
}

@Command({
  name: 'tenant:thaw',
  arguments: '<tenant>',
  description: 'Make a frozen tenant writable again (aborts its move)',
})
@Injectable()
export class TenantThawCommand extends Moving {
  async run([ref]: string[], options: MoveOptions) {
    const tenant = await this.accounts.tenant(ref!);
    const { changed } = await refusing(() =>
      carryOut(
        this.confirmer,
        {
          summary: [
            `Thaw "${tenant.slug}": writable again. An archive already written goes out of date with the first change: export again before importing it.`,
          ],
          apply: (operator) =>
            this.moves.freeze(this.actor, tenant.id, false, by(operator)),
        },
        options,
      ),
    );
    console.log(
      changed
        ? `"${tenant.slug}" is writable again.`
        : `"${tenant.slug}" was not frozen.`,
    );
  }
}

@Command({
  name: 'tenant:export',
  arguments: '<tenant>',
  description:
    "Write a tenant's encrypted archive for its move to a server of its own (freezes it first; prints the key once)",
})
@Injectable()
export class TenantExportCommand extends Moving {
  async run([ref]: string[], options: MoveOptions) {
    if (!options.out) {
      throw new CliError('Name the archive directory: --out <path>.');
    }
    const out = options.out;
    const tenant = await this.accounts.tenant(ref!);
    const accounts = await this.moves.accounts(tenant.id);
    const shared = sharedLines(accounts);
    const summary = [
      `Write "${tenant.slug}" (${tenant.name}) to ${out}: every row of the tenant, ${accounts.length} account(s) with their passwords, two-factor and passkeys (no sessions), and its files, encrypted with a new key shown once.`,
    ];
    if (!tenant.frozenAt) {
      summary.push(
        `It is not frozen: it is frozen first, read only for everyone until it is erased here (tenant:moved) or thawed (tenant:thaw ${tenant.slug}).`,
      );
    }
    if (shared.length > 0) {
      summary.push(
        `${shared.length} account(s) also belong to other tenants here: they are copied, and from then on the two copies are independent.`,
      );
    }
    let frozenHere = false;
    const { key, manifest } = await refusing(() =>
      carryOut(
        this.confirmer,
        {
          summary,
          apply: async (operator) => {
            if (!tenant.frozenAt) {
              await this.moves.freeze(
                this.actor,
                tenant.id,
                true,
                by(operator),
              );
              frozenHere = true;
            }
            return this.moves.export(this.actor, tenant.id, out);
          },
        },
        options,
      ),
    ).catch((error: unknown) => {
      if (frozenHere) {
        console.error(
          `"${tenant.slug}" stays frozen. To abort the move: pnpm ops tenant:thaw ${tenant.slug}`,
        );
      }
      throw error;
    });
    const rows = manifest.tables.reduce((sum, table) => sum + table.rows, 0);
    console.log(
      `Wrote ${rows} row(s) of ${manifest.tables.length} table(s), ${manifest.files.length} file(s) and ${manifest.accounts.length} account(s) to ${out}.`,
    );
    if (shared.length > 0) {
      console.log('Copied, and staying here too (they belong elsewhere):');
      for (const line of shared) console.log(line);
    }
    for (const missing of manifest.missingFiles) {
      console.log(`  Named by a row but missing on this disk: ${missing}`);
    }
    console.log(
      `\nArchive key, shown once (tenant:import asks for it; keep it apart from the archive):\n\n  ${key}\n`,
    );
    console.log(
      `Next: copy ${out} to the new server and run tenant:import there; once it says verified, run tenant:moved ${tenant.slug} here. To abort: tenant:thaw ${tenant.slug}.`,
    );
  }
  @Option({
    flags: '-o, --out <path>',
    description: 'a new (or empty) directory for the archive',
  })
  parseOut(value: string) {
    return value;
  }
}

@Command({
  name: 'tenant:import',
  arguments: '<archive>',
  description:
    "Put a tenant's archive on this server and verify it; run again, it verifies and copies only what is missing",
})
@Injectable()
export class TenantImportCommand extends Moving {
  constructor(
    accounts: Accounts,
    moves: TenantMoveService,
    confirmer: Confirmer,
    system: SystemContext,
    private readonly inquirer: InquirerService,
  ) {
    super(accounts, moves, confirmer, system);
  }

  async run([dir]: string[], options: MoveOptions) {
    const key = options.keyFile
      ? (await readFile(options.keyFile, 'utf8')).trim()
      : await this.askKey();
    const { manifest, present, problems } = await refusing(() =>
      this.moves.inspect(dir!, key),
    );
    if (problems.length > 0) {
      throw new CliError(
        ['Nothing was imported:', ...problems.map((p) => `  ${p}`)].join('\n'),
      );
    }
    const { slug, name } = manifest.tenant;
    const rows = manifest.tables.reduce((sum, table) => sum + table.rows, 0);
    const shared = sharedLines(manifest.accounts);
    const summary = present
      ? [
          `"${slug}" is here already: verify it against the archive, and copy any file it lacks.`,
        ]
      : [
          `Import "${slug}" (${name}): ${rows} row(s) of ${manifest.tables.length} table(s) in one transaction, then ${manifest.files.length} file(s), then verify everything.`,
          `${manifest.accounts.length} account(s) come with it; their sessions do not: people sign in again.`,
        ];
    if (shared.length > 0 && !present) {
      summary.push(
        `${shared.length} account(s) also belong to other tenants on the source: copied, independent from then on.`,
      );
    }
    const result = await refusing(() =>
      carryOut(
        this.confirmer,
        {
          summary,
          apply: () => this.moves.import(this.actor, dir!, key),
        },
        options,
      ),
    );
    console.log(
      result.alreadyHere
        ? `"${slug}" was here already: verified (${result.copiedFiles} file(s) copied now).`
        : `Imported "${slug}" and verified it: ${rows} row(s), ${manifest.files.length} file(s), ${manifest.accounts.length} account(s).`,
    );
    if (shared.length > 0) {
      console.log(
        'Copies of accounts that also belong elsewhere on the source:',
      );
      for (const line of shared) console.log(line);
    }
    console.log(
      `Next: start the app here; then, on the source, tenant:moved ${slug}.`,
    );
  }

  private async askKey() {
    if (!process.stdin.isTTY) {
      throw new CliError(
        'No terminal to ask the archive key on: pass --key-file <path>.',
      );
    }
    const { key } = await this.inquirer.ask<{ key: string }>(
      'tenant-move-key',
      undefined,
    );
    return key.trim();
  }

  @Option({
    flags: '-k, --key-file <path>',
    description: 'a file holding the archive key (else it is asked)',
  })
  parseKeyFile(value: string) {
    return value;
  }
}

@Command({
  name: 'tenant:moved',
  arguments: '<tenant>',
  description:
    'Erase a moved tenant from this server for good, once its import is verified on the new one',
})
@Injectable()
export class TenantMovedCommand extends Moving {
  async run([ref]: string[], options: MoveOptions) {
    const tenant = await this.accounts.tenant(ref!);
    const { accounts, onlyHere } = await refusing(() =>
      this.moves.finishing(tenant.id),
    );
    const erase = options.eraseAccounts === true;
    const summary = [
      `Erase "${tenant.slug}" (${tenant.name}) from this server for good: every row of it, and its files. Only once tenant:import said verified on the new server.`,
      erase
        ? `Then delete the ${onlyHere.length} of its ${accounts} account(s) that belong to no other tenant here (as an account deletion: their data and files; a legal hold keeps one). Accounts in another tenant stay.`
        : `Accounts stay: ${onlyHere.length} of its ${accounts} belong to no other tenant here and are left with none (--erase-accounts deletes them).`,
      ...onlyHere.map((account) => `  ${account.email}`),
    ];
    const result = await refusing(() =>
      carryOut(
        this.confirmer,
        {
          summary,
          apply: (operator) =>
            this.moves.finish(this.actor, tenant.id, by(operator), {
              eraseAccounts: erase,
            }),
        },
        options,
      ),
    );
    console.log(
      `Erased "${tenant.slug}" here. Its files are deleted once the worker delivers the outbox.`,
    );
    if (erase) {
      for (const email of result.erased)
        console.log(`  Account deleted: ${email}`);
      for (const email of result.held) {
        console.log(
          `  Kept by a legal hold (deleted once it is lifted): ${email}`,
        );
      }
    } else if (result.accounts.length > 0) {
      console.log('Accounts left in no tenant:');
      for (const account of result.accounts) console.log(`  ${account.email}`);
      console.log(
        'To delete one later: pnpm ops account:erase <email> (an account in no tenant only).',
      );
    }
  }

  @Option({
    flags: '--erase-accounts',
    description:
      'also delete the accounts left in no tenant, as an account deletion (never by default)',
  })
  parseEraseAccounts() {
    return true;
  }
}

@Command({
  name: 'account:erase',
  arguments: '<email>',
  description:
    'Delete an account that belongs to no tenant (one a tenant:moved left), as an account deletion',
})
@Injectable()
export class AccountEraseCommand extends Moving {
  async run([email]: string[], options: MoveOptions) {
    const deleted = await refusing(() =>
      carryOut(
        this.confirmer,
        {
          summary: [
            `Delete the account ${email} now, as its own deletion would: its data and files, anonymised, signed out. Only an account in no tenant; a legal hold keeps it.`,
          ],
          apply: (operator) =>
            this.moves.eraseAccount(this.actor, email!, by(operator)),
        },
        options,
      ),
    );
    console.log(
      deleted
        ? `Deleted the account ${email}.`
        : `${email} is kept by a legal hold: deleted once it is lifted.`,
    );
  }
}

export const TENANT_MOVE_COMMANDS = [
  TenantFreezeCommand,
  TenantThawCommand,
  TenantExportCommand,
  TenantImportCommand,
  TenantMovedCommand,
  AccountEraseCommand,
];

export const TENANT_MOVE_PROVIDERS = [
  ArchiveKeyQuestion,
  ...TENANT_MOVE_COMMANDS,
];
