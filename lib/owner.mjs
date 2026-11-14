// Firma de los mensajes que el propietario envía desde su ventana.
// La clave vive fuera de la carpeta del canal, en el perfil del usuario, y solo la crea la ventana.
// Distingue la ventana del propietario de un `post --as propietario` cualquiera; no es una frontera
// de seguridad frente a un programa que corra con el mismo usuario del sistema y lea la clave.
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
  if (record?.from !== 'propietario' || typeof record.ownerSignature !== 'string') return false;
  const secret = key(false);
  if (!secret) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(payload(record)).digest('hex'), 'hex');
  const actual = Buffer.from(record.ownerSignature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
