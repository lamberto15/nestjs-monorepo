// The `approvals` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons approvals` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import {
  CORE,
  WORKERS,
  importLines,
  src,
} from '../../../schematics/feature/kit.js';

/** The effect of each approvable action (modules/approvals). */
function effects(c) {
  return (
    importLines(
      [
        ['Injectable', '@nestjs/common'],
        ['ApprovalEffect', src(c, 'modules/approvals/approvals.registry.js')],
        [
          'ApprovalEffectHandler',
          src(c, 'modules/approvals/approvals.registry.js'),
        ],
      ],
      new Set(['ApprovalEffectHandler']),
    ) +
    '\n' +
    c.approvals
      .map(
        (a) =>
          '\n/**\n * What `' +
          a.action +
          '` does once it is applied: at once while its approval is\n' +
          ' * off (the setting `' +
          c.t.pluralCamel +
          '.' +
          a.action +
          'Approval`), else once approved.\n */\n' +
          "@ApprovalEffect({ subject: '" +
          c.t.Singular +
          "', action: '" +
          a.action +
          "' })\n@Injectable()\n" +
          'export class ' +
          a.className +
          ' implements ApprovalEffectHandler {\n' +
          'apply(): Promise<void> {\n' +
          '// Business logic: what "' +
          a.label +
          '" does to the record, from\n' +
          '// `apply(applied: ApprovalApplied)` (`applied.id`, `applied.actor`), through its\n' +
          "// store: `records.of('" +
          c.t.Singular +
          "').store.update(applied.actor, applied.id, { … })`\n" +
          '// (Records, modules/records). It may run more than once: make it idempotent.\n' +
          'return Promise.resolve();\n}\n}\n',
      )
      .join('')
  );
}

/** `--approvals publish,markPaid`: the actions that need approval. */
function parseApprovals(list, t, reserved) {
  const actions = String(list || 'publish')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  return actions.map((action) => {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(action) || reserved.has(action)) {
      throw new Error(
        '--approvals: "' +
          action +
          '" is not an action: a camelCase word (publish, markPaid) that is not a route of the record.',
      );
    }
    const words = action.replace(/[A-Z]/g, (l) => ' ' + l.toLowerCase());
    return {
      action,
      path: action.replace(/[A-Z]/g, (l) => '-' + l.toLowerCase()),
      label: words[0].toUpperCase() + words.slice(1) + ' ' + t.aNoun,
      className: action[0].toUpperCase() + action.slice(1) + t.Singular,
    };
  });
}

export default {
  order: 110,
  about: 'actions that need approval before they run (--approvals)',
  imports: { ApprovalsModule: 'modules/approvals/approvals.module.js' },
  call: (c) =>
    `ApprovalsModule.forRecord(${c.R}, { ${c.approvals.map((a) => `${a.action}: { label: '${a.label}' }`).join(', ')} })`,
  own: (c) =>
    Object.fromEntries(
      c.approvals.map((a) => [a.className, `./${c.t.singular}.approvals.js`]),
    ),
  providers: (c) => c.approvals.map((a) => a.className),
  boot: {
    QueuesModule: CORE.QueuesModule,
    SharedWorkflowsModule: CORE.SharedWorkflowsModule,
  },
  env: WORKERS,
  test: (c) => `
it('approvals: ${c.approvals[0].action} runs at once while its approval is off', async () => {
  const item = await create();
  const asked = await call('POST', \`${c.url}/\${item.id}/${c.approvals[0].path}\`, ${c.writer}, {});
  expect(asked.statusCode, asked.body).toBe(200);
  expect(asked.json()).toMatchObject({ status: 'applied' });
});`,
  prepare: (c, options, addons) => ({
    // Not an action: the record's own route, and those of every add-on.
    approvals: parseApprovals(
      options.approvals,
      c.t,
      new Set([
        'restore',
        ...Object.values(addons).flatMap((addon) => addon.routes ?? []),
      ]),
    ),
  }),
  files: (c) => ({ [c.t.singular + '.approvals.ts']: effects(c) }),
  readme: (c) => [
    '- `' + c.t.singular + '.approvals.ts`: what each approvable action does.',
  ],
};
