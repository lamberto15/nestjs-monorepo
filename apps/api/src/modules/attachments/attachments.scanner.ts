import { connect } from 'node:net';
import type { Readable } from 'node:stream';

/** What a scan found: clean, or infected with the signature's name. */
export type ScanResult =
  { infected: false } | { infected: true; signature: string };

/**
 * Scans a file's bytes for malware. The attachments' scan job calls it with
 * a read stream of the stored file. `scan()` answers only when the scanner
 * did its job; a scanner that is away or fails *throws*, never answers
 * "clean" (the job tries again, and the file stays pending).
 */
export abstract class MalwareScanner {
  /** False for `off`: uploads are not scanned and never pending. */
  abstract readonly enabled: boolean;
  abstract scan(file: Readable): Promise<ScanResult>;
}

/** MALWARE_SCANNER=off (the default): nothing is scanned, files are clean on upload. */
export class OffMalwareScanner extends MalwareScanner {
  readonly enabled = false;
  scan(file: Readable): Promise<ScanResult> {
    file.destroy();
    return Promise.reject(new Error('Malware scanning is off.'));
  }
}

/** The standard anti-malware test file: harmless, and every scanner flags it. */
export const EICAR =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * MALWARE_SCANNER=memory, for tests: reads the file and flags the EICAR test
 * string (signature `Eicar-Test-Signature`, as ClamAV names it). `down`
 * makes it throw, as an unreachable clamd does; `scanned` counts the calls;
 * `enabled = false` is MALWARE_SCANNER switched back to `off`.
 */
export class MemoryMalwareScanner extends MalwareScanner {
  enabled = true;
  down = false;
  scanned = 0;

  async scan(file: Readable): Promise<ScanResult> {
    this.scanned += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of file)
      chunks.push(Buffer.from(chunk as Uint8Array));
    if (this.down) {
      throw new Error('The scanner is down.');
    }
    return Buffer.concat(chunks).includes(EICAR)
      ? { infected: true, signature: 'Eicar-Test-Signature' }
      : { infected: false };
  }
}
/** Bytes per INSTREAM chunk (clamd's StreamMaxLength is the file's, not the chunk's, limit). */
const CHUNK = 64 * 1024;

export interface ClamavOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

/**
 * Parses clamd's answer to INSTREAM (`stream: OK`, `stream: <name> FOUND`,
 * `<message> ERROR`), a NUL-terminated line. An error is thrown: a file
 * clamd could not scan is not a clean one.
 */
export function parseClamdReply(reply: string): ScanResult {
  let end = reply.length;
  while (end > 0 && reply.charCodeAt(end - 1) === 0) end -= 1;
  const text = reply.slice(0, end).trim();
  if (text === 'stream: OK') {
    return { infected: false };
  }
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) {
    return { infected: true, signature: found[1]! };
  }
  throw new Error(`clamd answered: ${text || '(nothing)'}`);
}

/**
 * clamd over TCP, the INSTREAM command
 * (https://docs.clamav.net/manual/Usage/Scanning.html#clamd): `zINSTREAM\0`,
 * then the file as chunks of a 4-byte big-endian length and the bytes, then
 * a zero length; clamd answers one NUL-terminated line. Custom code on
 * purpose: the protocol is about forty lines, and the npm clients are
 * unmaintained (`clamdjs` last released in 2022, `clamscan` in 2024, which
 * also drives local binaries and callbacks). The file is streamed, never
 * held in memory; the socket's backpressure paces the read. One connection
 * per scan, closed after the answer. clamd's `StreamMaxLength` must be at
 * least ATTACHMENT_MAX_MB, else it answers "INSTREAM size limit exceeded"
 * (an error: the scan fails, the file stays pending).
 */
export class ClamavScanner extends MalwareScanner {
  readonly enabled = true;

  constructor(private readonly options: ClamavOptions) {
    super();
  }

  scan(file: Readable): Promise<ScanResult> {
    const { host, port, timeoutMs } = this.options;
    return new Promise<ScanResult>((resolve, reject) => {
      const socket = connect({ host, port });
      const reply: Buffer[] = [];
      let settled = false;
      const done = (error?: Error, result?: ScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        file.destroy();
        if (error) reject(error);
        else resolve(result!);
      };
      socket.setTimeout(timeoutMs, () =>
        done(new Error(`clamd did not answer within ${timeoutMs} ms.`)),
      );
      socket.on('error', (error) => done(error));
      socket.on('data', (chunk) => reply.push(Buffer.from(chunk)));
      socket.on('end', () => {
        try {
          done(
            undefined,
            parseClamdReply(Buffer.concat(reply).toString('utf8')),
          );
        } catch (error) {
          done(error as Error);
        }
      });
      socket.on('close', () =>
        done(new Error('clamd closed the connection without an answer.')),
      );
      socket.on('connect', () => {
        void (async () => {
          try {
            socket.write('zINSTREAM\0');
            for await (const bytes of file) {
              const data = Buffer.from(bytes as Uint8Array);
              for (let at = 0; at < data.length; at += CHUNK) {
                const part = data.subarray(at, at + CHUNK);
                const length = Buffer.alloc(4);
                length.writeUInt32BE(part.length);
                if (!socket.write(Buffer.concat([length, part]))) {
                  await new Promise<void>((resume) => {
                    socket.once('drain', resume);
                    socket.once('close', resume); // never waits on a dead socket
                  });
                }
                if (settled) return; // clamd already answered (a limit) or failed
              }
            }
            socket.write(Buffer.alloc(4)); // the zero length ends the stream
          } catch (error) {
            done(error as Error);
          }
        })();
      });
    });
  }
}
/** The scanner MALWARE_SCANNER names (the provider's factory). */
export function malwareScanner(config: {
  malwareScanner: 'off' | 'clamav' | 'memory';
  clamav: { host?: string; port: number; timeoutMs: number };
}): MalwareScanner {
  switch (config.malwareScanner) {
    case 'clamav': {
      if (!config.clamav.host) {
        throw new Error('MALWARE_SCANNER=clamav needs CLAMAV_HOST.');
      }
      return new ClamavScanner({ ...config.clamav, host: config.clamav.host });
    }
    case 'memory':
      return new MemoryMalwareScanner();
    default:
      return new OffMalwareScanner();
  }
}
