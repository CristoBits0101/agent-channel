// Signs the messages the owner sends from the window.
// The key lives outside the channel folder, in the user profile, and only the window creates it.
// It tells the owner's window apart from any `post --as owner`; it is not a security boundary
// against a program that runs as the same system user and reads the key.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ownerKeyFile as keyFile } from './paths.mjs';
let cached = null;

function key(create = false) {
  if (cached) return cached;
  if (!existsSync(keyFile)) {
    if (!create) return null;
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  cached = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
  return cached;
}

const payload = record => JSON.stringify([record.id, record.at, record.from, record.to, record.task ?? null, record.text]);

export const ownerSigner = () => {
  const secret = key(true);
  return record => createHmac('sha256', secret).update(payload(record)).digest('hex');
};

export function isOwnerSigned(record) {
  if (record?.from !== 'owner' || typeof record.ownerSignature !== 'string') return false;
  const secret = key(false);
  if (!secret) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(payload(record)).digest('hex'), 'hex');
  const actual = Buffer.from(record.ownerSignature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
