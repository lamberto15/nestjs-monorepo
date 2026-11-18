import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { StorageDisk } from '@nestjs/storage';
import { Diagnostic, type DiagnosticProbe } from '../ops/ops.diagnostics.js';

/** Storage as the operators' diagnostics test it: a probe file written, read back and deleted at once. */
@Diagnostic({ name: 'storage', onDemand: true })
@Injectable()
export class StorageDiagnostic implements DiagnosticProbe {
  constructor(private readonly disk: StorageDisk) {}

  async check() {
    const key = `ops/diagnostics/${randomUUID()}.txt`;
    try {
      await this.disk.put(key, Buffer.from('diagnostics probe'));
      await this.disk.getBuffer(key);
    } finally {
      await this.disk.delete(key);
    }
  }
}
