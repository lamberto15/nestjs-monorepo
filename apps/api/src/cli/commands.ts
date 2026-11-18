import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { EncryptionAdminService } from '../modules/encryption-admin/encryption-admin.service.js';
import { OpsDiagnostics } from '../modules/ops/ops.diagnostics.js';
import { OpsService } from '../modules/ops/ops.service.js';
import { randomBytes } from 'node:crypto';
import { Accounts } from './accounts.service.js';
import { Confirmer } from './confirm.js';
import { type BacklogOptions, Operations } from './operations.service.js';
import { currentOperator } from './operator.js';
import type { OneTimePassword, Plan } from './plan.js';

/** Every changing command's options. */
interface ChangeOptions {
  yes?: boolean;
  tenant?: string;
  name?: string;
  admin?: string;
  all?: boolean;
  platform?: boolean;
  before?: string;
}

const YES = {
  flags: '-y, --yes',
  description: 'do not ask for confirmation (scripts)',
} as const;

/**
 * Shows the plan, asks (unless `--yes`), applies it as the operator of this
 * shell. Output goes straight to stdout, never through the app's logger: a
 * one-time password is on the terminal and nowhere else.
 */
async function carryOut<T>(
  confirmer: Confirmer,
  plan: Plan<T>,
  options: ChangeOptions,
) {
  await confirmer.confirm(plan, options.yes);
  return plan.apply(currentOperator());
}

function showPassword({ email, password }: OneTimePassword) {
  console.log(
    `\nOne-time password for ${email}, shown once (the user changes it after signing in):\n\n  ${password}\n`,
  );
}

@Injectable()
abstract class Changing extends CommandRunner {
  constructor(
    protected readonly accounts: Accounts,
    protected readonly confirmer: Confirmer,
  ) {
    super();
  }

  @Option(YES) parseYes() {
    return true;
  }
}

// Tenants and accounts

@Command({ name: 'tenant:list', description: 'List the tenants' })
@Injectable()
export class TenantListCommand extends CommandRunner {
  constructor(private readonly accounts: Accounts) {
    super();
  }
  async run() {
    for (const tenant of await this.accounts.tenantList()) {
      console.log(
        [
          tenant.id,
          tenant.slug.padEnd(24),
          `${tenant.members} members`.padEnd(12),
          tenant.active ? 'active' : 'inactive',
        ].join('  '),
        `  ${tenant.name}`,
      );
    }
  }
}

@Command({
  name: 'tenant:create',
  arguments: '<slug>',
  description:
    'Create a tenant with its first administrator (a new account gets a one-time password)',
})
@Injectable()
export class TenantCreateCommand extends Changing {
  async run([slug]: string[], options: ChangeOptions) {
    if (!options.admin) {
      throw new Error('Name the administrator: --admin <email>.');
    }
    const { administrator } = await carryOut(
      this.confirmer,
      this.accounts.tenantCreate(slug!, {
        name: options.name,
        admin: options.admin,
      }),
      options,
    );
    console.log(`Created the tenant "${slug}".`);
    if (administrator.password) {
      showPassword(administrator.password);
    }
  }
  @Option({
    flags: '-n, --name <name>',
    description: "the tenant's name (default: its slug)",
  })
  parseName(value: string) {
    return value;
  }
  @Option({
    flags: '-a, --admin <email>',
    description: "the first administrator's address",
  })
  parseAdmin(value: string) {
    return value;
  }
}

@Command({
  name: 'admin:create',
  arguments: '<email>',
  description:
    'Make an account an administrator of a tenant (a new account gets a one-time password)',
})
@Injectable()
export class AdminCreateCommand extends Changing {
  async run([email]: string[], options: ChangeOptions) {
    if (!options.tenant) {
      throw new Error('Name the tenant: --tenant <id|slug>.');
    }
    const plan = await this.accounts.adminCreate(email!, {
      tenant: options.tenant,
      name: options.name,
    });
    const result = await carryOut(this.confirmer, plan, options);
    if (!result.changed) {
      console.log(
        `${email} is an administrator of "${result.tenant}" already: nothing changed.`,
      );
      return;
    }
    console.log(`${email} is now an administrator of "${result.tenant}".`);
    if (result.password) {
      showPassword(result.password);
    }
  }
  @Option({ flags: '-t, --tenant <tenant>', description: 'tenant id or slug' })
  parseTenant(value: string) {
    return value;
  }
  @Option({ flags: '-n, --name <name>', description: "a new account's name" })
  parseName(value: string) {
    return value;
  }
}

@Command({
  name: 'user:reset-password',
  arguments: '<email>',
  description: 'Set a one-time password and sign the account out everywhere',
})
@Injectable()
export class ResetPasswordCommand extends Changing {
  async run([email]: string[], options: ChangeOptions) {
    showPassword(
      await carryOut(
        this.confirmer,
        await this.accounts.resetPassword(email!),
        options,
      ),
    );
  }
}

@Command({
  name: 'user:remove-mfa',
  arguments: '<email>',
  description: "Remove an account's authenticator and recovery codes",
})
@Injectable()
export class RemoveMfaCommand extends Changing {
  async run([email]: string[], options: ChangeOptions) {
    await carryOut(
      this.confirmer,
      await this.accounts.removeMfa(email!),
      options,
    );
    console.log(`Two-factor removed from ${email}.`);
  }
}

@Command({
  name: 'user:unlock',
  arguments: '<email>',
  description: 'Clear the failed second-factor attempts of an account',
})
@Injectable()
export class UnlockCommand extends Changing {
  async run([email]: string[], options: ChangeOptions) {
    const { failures } = await carryOut(
      this.confirmer,
      await this.accounts.unlock(email!),
      options,
    );
    console.log(`Cleared ${failures} failed attempt(s) of ${email}.`);
  }
}

// Queues and dead letters (modules/ops)

@Command({
  name: 'queue:list',
  description: 'List the queues: state and counts',
})
@Injectable()
export class QueueListCommand extends CommandRunner {
  constructor(private readonly ops: OpsService) {
    super();
  }
  async run() {
    for (const queue of await this.ops.queueStates()) {
      const { waiting, active, delayed, failed } = queue.counts;
      console.log(
        `${queue.name.padEnd(28)} ${queue.paused ? 'PAUSED ' : 'running'}  workers ${queue.workers}  waiting ${waiting}  active ${active}  delayed ${delayed}  failed ${failed}`,
      );
    }
  }
}

/** A queue's command: the plan is one line, the change is the service's. */
abstract class QueueChange extends CommandRunner {
  constructor(
    protected readonly ops: OpsService,
    protected readonly confirmer: Confirmer,
  ) {
    super();
  }
  @Option(YES) parseYes() {
    return true;
  }
  protected async change(
    name: string,
    options: ChangeOptions,
    summary: string,
    apply: () => Promise<unknown>,
  ) {
    this.ops.queue(name); // a 404 before asking
    await carryOut(this.confirmer, { summary: [summary], apply }, options);
    console.log('Done.');
  }
}

@Command({
  name: 'queue:pause',
  arguments: '<name>',
  description: 'Pause a queue for every worker',
})
@Injectable()
export class QueuePauseCommand extends QueueChange {
  run([name]: string[], options: ChangeOptions) {
    return this.change(
      name!,
      options,
      `Pause the queue "${name}": its jobs wait, running ones finish.`,
      () => this.ops.pause(name!),
    );
  }
}

@Command({
  name: 'queue:resume',
  arguments: '<name>',
  description: 'Resume a paused queue',
})
@Injectable()
export class QueueResumeCommand extends QueueChange {
  run([name]: string[], options: ChangeOptions) {
    return this.change(name!, options, `Resume the queue "${name}".`, () =>
      this.ops.resume(name!),
    );
  }
}

@Command({
  name: 'queue:retry-failed',
  arguments: '<name>',
  description: "Run a queue's failed jobs again",
})
@Injectable()
export class QueueRetryCommand extends QueueChange {
  run([name]: string[], options: ChangeOptions) {
    return this.change(
      name!,
      options,
      `Run the failed jobs of "${name}" again.`,
      () => this.ops.retryFailed(name!),
    );
  }
}

@Command({
  name: 'dead-letter:list',
  description: 'List the outbox dead letters, newest first',
})
@Injectable()
export class DeadLetterListCommand extends CommandRunner {
  constructor(private readonly ops: OpsService) {
    super();
  }
  async run() {
    for (const letter of await this.ops.listDeadLetters({
      limit: 50,
      offset: 0,
    })) {
      console.log(
        `${letter.id}  ${letter.failedAt}  ${letter.topic}  ${letter.reason}  ${letter.lastError ?? ''}`,
      );
    }
  }
}

/** Retry and discard take ids, or `--all`. */
abstract class DeadLetterChange extends CommandRunner {
  constructor(
    protected readonly ops: OpsService,
    protected readonly confirmer: Confirmer,
  ) {
    super();
  }
  @Option(YES) parseYes() {
    return true;
  }
  @Option({
    flags: '--all',
    description: 'every dead letter (when no id is given)',
  })
  parseAll() {
    return true;
  }
  protected target(ids: string[], options: ChangeOptions) {
    if (ids.length === 0 && !options.all) {
      throw new Error('Give dead letter ids, or --all.');
    }
    return ids.length ? { ids } : {};
  }
}

@Command({
  name: 'dead-letter:retry',
  arguments: '[ids...]',
  description: 'Move dead letters back to the outbox with a fresh retry budget',
})
@Injectable()
export class DeadLetterRetryCommand extends DeadLetterChange {
  async run(ids: string[], options: ChangeOptions) {
    const target = this.target(ids, options);
    const retried = await carryOut(
      this.confirmer,
      {
        summary: [`Retry ${ids.length || 'every'} dead letter(s).`],
        apply: () => this.ops.retryDeadLetters(target),
      },
      options,
    );
    console.log(`Retried ${retried}.`);
  }
}

@Command({
  name: 'dead-letter:discard',
  arguments: '[ids...]',
  description: 'Delete dead letters for good',
})
@Injectable()
export class DeadLetterDiscardCommand extends DeadLetterChange {
  async run(ids: string[], options: ChangeOptions) {
    const target = this.target(ids, options);
    const discarded = await carryOut(
      this.confirmer,
      {
        summary: [`Delete ${ids.length || 'every'} dead letter(s) for good.`],
        apply: () => this.ops.discardDeadLetters(target),
      },
      options,
    );
    console.log(`Discarded ${discarded}.`);
  }
}

// Encryption keys (modules/encryption-admin)

@Command({
  name: 'keys:generate',
  description:
    'Print a new key for DATA_ENCRYPTION_KEYS or BLIND_INDEX_KEYS (put it first, keep the old ones)',
})
@Injectable()
export class KeyGenerateCommand extends CommandRunner {
  run() {
    console.log(randomBytes(32).toString('base64'));
    return Promise.resolve();
  }
}

@Command({
  name: 'keys:status',
  description: 'Which encrypted rows are still on an old key',
})
@Injectable()
export class KeyStatusCommand extends CommandRunner {
  constructor(private readonly encryption: EncryptionAdminService) {
    super();
  }
  async run() {
    const status = await this.encryption.status();
    console.log(
      `data key ${status.dataKeyId ?? '-'}, index key ${status.indexKeyId ?? '-'}`,
    );
    for (const column of status.columns) {
      console.log(
        `${column.column.padEnd(40)} ${column.staleRows} on an old key`,
      );
    }
    console.log(
      status.upToDate
        ? 'Up to date: the old keys may leave.'
        : 'Not up to date: run keys:reencrypt.',
    );
  }
}

@Command({
  name: 'keys:reencrypt',
  description: 'Move every row to the current keys now, in this process',
})
@Injectable()
export class KeyReencryptCommand extends CommandRunner {
  constructor(
    private readonly encryption: EncryptionAdminService,
    private readonly confirmer: Confirmer,
  ) {
    super();
  }
  @Option(YES) parseYes() {
    return true;
  }
  async run(_: string[], options: ChangeOptions) {
    const result = await carryOut(
      this.confirmer,
      {
        summary: [
          'Rewrite every encrypted row still on an old key under the current keys.',
        ],
        apply: () => this.encryption.runNow(),
      },
      options,
    );
    console.log(`Rewrote ${result.rewritten}, ${result.failed} did not open.`);
  }
}

// Users, settings, notifications, diagnostics, backlog

@Command({
  name: 'user:list',
  arguments: '<tenant>',
  description: "List a tenant's users (id or slug): roles, two-factor",
})
@Injectable()
export class UserListCommand extends CommandRunner {
  constructor(private readonly accounts: Accounts) {
    super();
  }
  async run([tenant]: string[]) {
    const { members } = await this.accounts.userList(tenant!);
    for (const member of members) {
      console.log(
        [
          member.email.padEnd(36),
          (member.roles.join(',') || '-').padEnd(24),
          member.mfa ? 'mfa' : '   ',
          member.accountActive && member.membershipActive
            ? 'active'
            : 'INACTIVE',
        ].join('  '),
      );
    }
  }
}

/** A command that acts through Operations (settings, notifications, backlog). */
@Injectable()
abstract class Operating extends CommandRunner {
  constructor(
    protected readonly operations: Operations,
    protected readonly confirmer: Confirmer,
  ) {
    super();
  }
  @Option(YES) parseYes() {
    return true;
  }
}

@Command({
  name: 'setting:delete',
  arguments: '<key>',
  description: "Delete a stored setting value (a tenant's, or the platform's)",
})
@Injectable()
export class SettingDeleteCommand extends Operating {
  async run([key]: string[], options: ChangeOptions) {
    await carryOut(
      this.confirmer,
      await this.operations.settingDelete(key!, options),
      options,
    );
    console.log(`Deleted the stored value of "${key}", if there was one.`);
  }
  @Option({
    flags: '-t, --tenant <tenant>',
    description: 'the tenant (id or slug) whose value to delete',
  })
  parseTenant(value: string) {
    return value;
  }
  @Option({
    flags: '-p, --platform',
    description: "delete the operators' platform-wide value",
  })
  parsePlatform() {
    return true;
  }
}

@Command({
  name: 'notifications:settle',
  arguments: '<email>',
  description:
    "Drop a user's undelivered notification backlog (no push or mail), leaving mandatory types",
})
@Injectable()
export class NotificationsSettleCommand extends Operating {
  async run([email]: string[], options: ChangeOptions) {
    const result = await carryOut(
      this.confirmer,
      await this.operations.notificationsSettle(email!, options),
      options,
    );
    console.log(
      `Settled ${email}: ${result.messages} message(s) deleted, ${result.notifications} notification(s) marked delivered and read.`,
    );
  }
  @Option({
    flags: '-b, --before <date>',
    description: 'only those created before this date (ISO 8601); default all',
  })
  parseBefore(value: string) {
    return value;
  }
}

@Command({
  name: 'diagnostics',
  description:
    'Show the integrations (database, Redis, workers, mail, storage…): state and driver; --test probes them safely',
})
@Injectable()
export class DiagnosticsCommand extends CommandRunner {
  constructor(private readonly diagnostics: OpsDiagnostics) {
    super();
  }
  async run(_args: string[], options: { test?: boolean }) {
    for (const item of await this.diagnostics.overview()) {
      let line = [
        item.name.padEnd(10),
        item.state.padEnd(12),
        (item.driver ?? '-').padEnd(12),
        item.detail ?? '',
      ]
        .join('  ')
        .trimEnd();
      if (options.test && item.testable) {
        const result = await this.diagnostics.test(item.name);
        line += `\n  test: ${result.ok ? 'ok' : `FAILED ${result.detail}`} (${result.durationMs} ms)`;
        if (!result.ok) process.exitCode = 1;
      } else if (item.state === 'unavailable') {
        process.exitCode = 1;
      }
      console.log(line);
    }
  }
  @Option({
    flags: '-t, --test',
    description:
      'also run the safe tests (SMTP connect and QUIT, a storage probe file written, read and deleted)',
  })
  parseTest() {
    return true;
  }
}

/** The `backlog:*` commands' scope options. */
@Injectable()
abstract class BacklogCommand extends Operating {
  @Option({
    flags: '-t, --tenant <tenant>',
    description: "one tenant's outbox backlog (id or slug)",
  })
  parseTenant(value: string) {
    return value;
  }
  @Option({
    flags: '-g, --global',
    description: "every tenant's backlog, and the mail queue",
  })
  parseGlobal() {
    return true;
  }
  @Option({ flags: '--topic <topic>', description: 'only this outbox topic' })
  parseTopic(value: string) {
    return value;
  }
  @Option({
    flags: '--template <mail>',
    description: 'only this mail class (the job name)',
  })
  parseTemplate(value: string) {
    return value;
  }
  @Option({
    flags: '-b, --before <date>',
    description: 'only what was created before this date (ISO 8601)',
  })
  parseBefore(value: string) {
    return value;
  }
}

@Command({
  name: 'backlog:count',
  description:
    'Count the outbox and mail backlog of --tenant or --global (a dry run: changes nothing)',
})
@Injectable()
export class BacklogCountCommand extends BacklogCommand {
  async run(_args: string[], options: BacklogOptions) {
    const { outbox, mail } = await this.operations.backlogCount(options);
    console.log(
      `Outbox: ${outbox.pending.total} pending, ${outbox.deadLetters.total} dead letter(s), ${outbox.leased} being delivered`,
    );
    for (const [label, part] of [
      ['pending', outbox.pending],
      ['dead', outbox.deadLetters],
    ] as const) {
      for (const group of part.groups) {
        console.log(
          `  ${label.padEnd(8)}  ${String(group.count).padStart(8)}  ${group.topic}`,
        );
      }
    }
    if (mail) {
      console.log(`Mail queue:${mail.capped ? ' (more than counted)' : ''}`);
      for (const group of mail.groups) {
        console.log(
          `  ${group.state.padEnd(11)}  ${String(group.count).padStart(8)}  ${group.template}${group.essential ? `  (${group.essential} essential: kept)` : ''}`,
        );
      }
    }
  }
}

@Command({
  name: 'backlog:discard',
  arguments: '<target>',
  description:
    'Discard the outbox or mail backlog (target: outbox | mail) of --tenant or --global, in batches; never in-flight or essential, audited',
})
@Injectable()
export class BacklogDiscardCommand extends BacklogCommand {
  async run([target]: string[], options: BacklogOptions & ChangeOptions) {
    const { count } = await carryOut(
      this.confirmer,
      await this.operations.backlogAction('discard', target!, options),
      options,
    );
    console.log(`Discarded ${count}.`);
  }
}

@Command({
  name: 'backlog:retry',
  arguments: '<target>',
  description:
    'Retry the failed backlog (outbox: dead letters; mail: failed jobs) of --tenant or --global, audited',
})
@Injectable()
export class BacklogRetryCommand extends BacklogCommand {
  async run([target]: string[], options: BacklogOptions & ChangeOptions) {
    const { count } = await carryOut(
      this.confirmer,
      await this.operations.backlogAction('retry', target!, options),
      options,
    );
    console.log(`Retried ${count}.`);
  }
}

export const COMMANDS = [
  TenantListCommand,
  TenantCreateCommand,
  AdminCreateCommand,
  ResetPasswordCommand,
  RemoveMfaCommand,
  UnlockCommand,
  QueueListCommand,
  QueuePauseCommand,
  QueueResumeCommand,
  QueueRetryCommand,
  DeadLetterListCommand,
  DeadLetterRetryCommand,
  DeadLetterDiscardCommand,
  UserListCommand,
  SettingDeleteCommand,
  NotificationsSettleCommand,
  DiagnosticsCommand,
  BacklogCountCommand,
  BacklogDiscardCommand,
  BacklogRetryCommand,
  KeyGenerateCommand,
  KeyStatusCommand,
  KeyReencryptCommand,
];
