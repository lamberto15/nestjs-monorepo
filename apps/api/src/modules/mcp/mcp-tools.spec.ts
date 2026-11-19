import { Injectable } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Can, Policy } from '@nestjs/authorization';
import { Tool } from '@nestjs/mcp';
import { Test } from '@nestjs/testing';
import { MCP_TOOL_METADATA } from '../mode/mode.guard.js';
import { CAN, CAN_ANYONE, McpToolChecks, McpTools } from './mcp-tools.js';

@McpTools()
@Injectable()
class Checked {
  @Tool({ name: 'checked' })
  @Can.Anyone()
  checked() {
    return 'ok';
  }
}

@McpTools()
@Injectable()
class Unchecked {
  @Tool({ name: 'unchecked' })
  unchecked() {
    return 'ok';
  }
}

@Injectable()
class Unmarked {
  @Tool({ name: 'unmarked' })
  @Can.Anyone()
  unmarked() {
    return 'ok';
  }
}

@Policy()
@Injectable()
class ThingPolicy {
  read() {
    return true;
  }
  update() {
    return true;
  }
}

@McpTools()
@Injectable()
class ReadOnlyWriter {
  @Tool({ name: 'sneaky', annotations: { readOnlyHint: true } })
  @Can(ThingPolicy, 'update')
  sneaky() {
    return 'ok';
  }

  @Tool({ name: 'reader', annotations: { readOnlyHint: true } })
  @Can(ThingPolicy, 'read')
  reader() {
    return 'ok';
  }
}

const start = async (...tools: (new () => object)[]) => {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [McpToolChecks, ...tools],
  }).compile();
  try {
    await moduleRef.init();
  } finally {
    await moduleRef.close();
  }
};

describe('McpToolChecks', () => {
  it('lets tools that declare their check start', async () => {
    await expect(start(Checked)).resolves.toBeUndefined();
  });

  // A provider's value may have no prototype (Object.create(null), as a
  // package's options object can): it has no class, so no tool.
  it('passes over a provider value without a prototype', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        McpToolChecks,
        Checked,
        { provide: 'BARE', useValue: Object.create(null) as object },
      ],
    }).compile();
    await expect(moduleRef.init()).resolves.toBeDefined();
    await moduleRef.close();
  });

  it('refuses a tool without @Can() or @Can.Anyone()', async () => {
    await expect(start(Checked, Unchecked)).rejects.toThrow(
      'Unchecked.unchecked: declares no @Can() or @Can.Anyone()',
    );
  });

  it('refuses a read-only tool whose @Can() asks for a write', async () => {
    const refused = start(ReadOnlyWriter);
    await expect(refused).rejects.toThrow(
      'ReadOnlyWriter.sneaky: declares readOnlyHint, and its @Can() asks for update',
    );
    await expect(refused).rejects.not.toThrow('ReadOnlyWriter.reader');
  });

  // The keys are the packages' internals (neither exports them): an
  // upgrade that renames one must fail here, not turn the checks off.
  it("reads the metadata keys the installed packages' decorators write", () => {
    class Probe {
      @Tool({ name: 'probe', annotations: { readOnlyHint: true } })
      @Can(ThingPolicy, 'read')
      probe() {}

      @Tool({ name: 'anyone' })
      @Can.Anyone()
      anyone() {}
    }
    const probe = Object.getOwnPropertyDescriptor(Probe.prototype, 'probe')!
      .value as object;
    const anyone = Object.getOwnPropertyDescriptor(Probe.prototype, 'anyone')!
      .value as object;
    expect(Reflect.getMetadata(MCP_TOOL_METADATA, probe)).toMatchObject({
      kind: 'tool',
      options: { name: 'probe', annotations: { readOnlyHint: true } },
    });
    expect(Reflect.getMetadata(CAN, probe)).toEqual([
      expect.objectContaining({ policy: ThingPolicy, ability: 'read' }),
    ]);
    expect(Reflect.getMetadata(CAN_ANYONE, anyone)).toBe(true);
  });

  it('refuses a tool whose class has no @McpTools()', async () => {
    await expect(start(Unmarked)).rejects.toThrow(
      'Unmarked.unmarked: its class has no @McpTools()',
    );
  });
});
