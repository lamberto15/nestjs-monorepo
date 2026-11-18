import { empty, runner } from '../../../test/schematic.js';

/** What `--addons approvals` adds to a generated feature (approvals.addon.js). */
describe('the approvals add-on of the feature generator', () => {
  it('writes the effect of each approvable action', async () => {
    const tree = await runner.runSchematic(
      'feature',
      {
        name: 'invoices',
        fields: 'title:string',
        addons: 'approvals',
        approvals: 'publish,markPaid',
        skipImport: true,
      },
      empty(),
    );
    const effects = tree.readContent(
      '/src/features/invoices/invoice.approvals.ts',
    );
    expect(effects).toContain('export class PublishInvoice');
    expect(effects).toContain('export class MarkPaidInvoice');
  });

  it.each(['restore', 'Publish'])(
    'refuses "%s" as an action: a route of the record, or not camelCase',
    async (approvals) => {
      await expect(
        runner.runSchematic(
          'feature',
          {
            name: 'invoices',
            fields: 'title:string',
            addons: 'approvals',
            approvals,
            skipImport: true,
          },
          empty(),
        ),
      ).rejects.toThrow('not an action');
    },
  );
});
