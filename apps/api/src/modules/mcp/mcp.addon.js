// The `mcp` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons mcp` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.

export default {
  order: 260,
  about: 'tools for AI agents (MCP): list, get, create, update, delete',
  imports: { McpModule: 'modules/mcp/mcp.module.js' },
  call: (c) => `McpModule.forRecord(${c.R})`,
  boot: { McpModule: 'modules/mcp/mcp.module.js' },
  test: (c) => `
it('mcp: its record tools are listed', async () => {
  const listed = await call('POST', '/v1/mcp', { ...${c.writer}, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(listed.statusCode, listed.body).toBe(200);
  expect(listed.body).toContain('"${c.url.slice(4)}_create"');
});`,
};
