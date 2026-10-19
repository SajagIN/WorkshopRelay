/**
 * Deterministic UUID derivation (RFC 4122 v5-style: SHA-1 of namespace+name).
 * Used by the seed so repeated seeding is idempotent with stable IDs.
 */
import { createHash } from 'node:crypto';

const DEFAULT_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function uuidV5(name: string, namespace: string = DEFAULT_NAMESPACE): string {
  const nsBytes = uuidToBytes(namespace);
  const hash = createHash('sha1').update(Buffer.concat([nsBytes, Buffer.from(name, 'utf8')])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(hash.subarray(0, 16));
}
