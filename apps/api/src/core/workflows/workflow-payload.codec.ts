import { createHash, hkdfSync } from 'node:crypto';
import { AesGcmPayloadCodec } from '@nestjs/workflows';

/** HKDF label: a data key never yields the bytes that encrypt columns. */
const WORKFLOW_KEY_INFO = 'app-workflow-payloads:v1';

/**
 * The codec that encrypts what workflows store (inputs, outputs, step
 * results, signal payloads, error messages): the package's AES-256-GCM
 * codec, under keys derived from DATA_ENCRYPTION_KEYS. The first key
 * encrypts and every listed key decrypts, as for encrypted columns; a key's
 * id is stored with each payload, so the order may change. No keys: no
 * codec, and payloads are stored as JSON (development).
 */
export function workflowPayloadCodec(
  dataKeys: readonly string[],
): AesGcmPayloadCodec | undefined {
  if (dataKeys.length === 0) {
    return undefined;
  }
  const keys: Record<string, Uint8Array> = {};
  const ids = dataKeys.map((material) => {
    const key = Buffer.from(
      hkdfSync('sha256', material, Buffer.alloc(0), WORKFLOW_KEY_INFO, 32),
    );
    const id = createHash('sha256').update(key).digest('base64url').slice(0, 6);
    keys[id] = key;
    return id;
  });
  return new AesGcmPayloadCodec({ keys, current: ids[0]! });
}
