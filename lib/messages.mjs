// Lectura y escritura del historial del canal (data/messages.jsonl). Una línea JSON por mensaje.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './store.mjs';

export const channelFile = process.env.AGENT_CHANNEL_FILE ?? join(dataDir, 'messages.jsonl');
export const participants = ['claude', 'codex', 'gemini', 'propietario'];
export const maxLength = 8000;
const taskPattern = /^T-\d{3,}$/;
const taskTag = /\[(T-\d{3,})\]/i;

export const readLines = () => existsSync(channelFile) ? readFileSync(channelFile, 'utf8').split('\n').filter(Boolean) : [];

export function readMessages(since = 0) {
  const messages = [];
  readLines().forEach((line, index) => {
    if (index + 1 <= since) return;
    let parsed;
    try { parsed = JSON.parse(line); } catch { parsed = null; }
    messages.push(parsed && typeof parsed === 'object' ? { ...parsed, seq: index + 1 } : { seq: index + 1, from: 'desconocido', to: 'todos', at: '', text: '[línea ilegible]' });
  });
  return messages;
}

// Un mensaje pertenece a una tarea por su campo task o, si lo escribió un agente sin ese campo,
// por la etiqueta [T-001] en el texto.
export const messageTask = message => (typeof message.task === 'string' && message.task) || taskTag.exec(String(message.text ?? ''))?.[1]?.toUpperCase() || null;

export function postMessage(from, text, to = 'todos', extra = {}) {
  if (!participants.includes(from)) throw new Error(`Participante desconocido: ${from}. Válidos: ${participants.join(', ')}`);
  if (to !== 'todos' && !participants.includes(to)) throw new Error(`Destinatario desconocido: ${to}. Válidos: todos, ${participants.join(', ')}`);
  const body = String(text ?? '').trim();
  if (!body) throw new Error('El mensaje está vacío.');
  if (body.length > maxLength) throw new Error(`El mensaje supera ${maxLength} caracteres.`);
  const task = extra.task ? String(extra.task).toUpperCase() : undefined;
  if (task && !taskPattern.test(task)) throw new Error(`Tarea no válida: ${extra.task}. Formato: T-001`);
  const model = extra.model ? String(extra.model).slice(0, 80) : undefined;
  mkdirSync(dirname(channelFile), { recursive: true });
  const id = randomUUID();
  const record = { id, at: new Date().toISOString(), from, to, text: body, task, model };
  if (typeof extra.sign === 'function') record.ownerSignature = extra.sign(record);
  appendFileSync(channelFile, `${JSON.stringify(record)}\n`);
  return readLines().findIndex(line => line.includes(id)) + 1;
}
