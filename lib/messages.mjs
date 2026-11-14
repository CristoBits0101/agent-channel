// Reads and writes the channel history (data/messages.jsonl), one JSON line per message.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './store.mjs';

export const channelFile = process.env.AGENT_CHANNEL_FILE ?? join(dataDir, 'messages.jsonl');
export const participants = ['claude', 'codex', 'gemini', 'owner'];
export const everyone = 'all';
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
    messages.push(parsed && typeof parsed === 'object' ? { ...parsed, seq: index + 1 } : { seq: index + 1, from: 'unknown', to: everyone, at: '', text: '[unreadable line]' });
  });
  return messages;
}

// A message belongs to a task through its task field or, when an agent wrote it without that field,
// through a [T-001] tag in the text.
export const messageTask = message => (typeof message.task === 'string' && message.task) || taskTag.exec(String(message.text ?? ''))?.[1]?.toUpperCase() || null;

export function postMessage(from, text, to = everyone, extra = {}) {
  if (!participants.includes(from)) throw new Error(`Unknown participant: ${from}. Valid: ${participants.join(', ')}`);
  if (to !== everyone && !participants.includes(to)) throw new Error(`Unknown recipient: ${to}. Valid: ${everyone}, ${participants.join(', ')}`);
  const body = String(text ?? '').trim();
  if (!body) throw new Error('The message is empty.');
  if (body.length > maxLength) throw new Error(`The message is longer than ${maxLength} characters.`);
  const task = extra.task ? String(extra.task).toUpperCase() : undefined;
  if (task && !taskPattern.test(task)) throw new Error(`Invalid task: ${extra.task}. Format: T-001`);
  const model = extra.model ? String(extra.model).slice(0, 80) : undefined;
  mkdirSync(dirname(channelFile), { recursive: true });
  const id = randomUUID();
  const record = { id, at: new Date().toISOString(), from, to, text: body, task, model };
  if (typeof extra.sign === 'function') record.ownerSignature = extra.sign(record);
  appendFileSync(channelFile, `${JSON.stringify(record)}\n`);
  return readLines().findIndex(line => line.includes(id)) + 1;
}
