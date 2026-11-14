// Shared store for tasks and the state agents declare about themselves.
// channel.mjs (each agent's MCP server and CLI) and server.mjs (the owner's window) are separate
// processes, so every write takes a directory lock and replaces the whole file.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userConfigDir } from './paths.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// A clone keeps its data inside the clone. An npm install keeps it in the user's config folder,
// because npm replaces the package folder on every update.
const installedByNpm = /[\\/]node_modules[\\/]/.test(root);
export const dataDir = process.env.AGENT_CHANNEL_DATA ?? (installedByNpm ? join(userConfigDir('agent-channel'), 'data') : join(root, 'data'));
export const tasksFile = join(dataDir, 'tasks.json');
export const declaredFile = join(dataDir, 'agents.json');
const lockDir = join(dataDir, '.store.lock');

export const agents = ['claude', 'codex', 'gemini'];
export const statuses = ['assigned', 'in_progress', 'done', 'verified', 'blocked'];
export const openStatuses = ['assigned', 'in_progress', 'blocked'];

const pause = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

function withLock(action) {
  mkdirSync(dataDir, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 10_000) rmSync(lockDir, { recursive: true, force: true });
      } catch {}
      if (Date.now() - started > 5000) throw new Error('The task store is busy. Try again.');
      pause(25);
    }
  }
  try {
    return action();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function readJson(file, fallback) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

const emptyTasks = () => ({ next: 1, tasks: [] });
export const readTasks = () => readJson(tasksFile, emptyTasks());
export const readDeclared = () => readJson(declaredFile, {});

const taskId = number => `T-${String(number).padStart(3, '0')}`;
const cleanText = (value, limit) => String(value ?? '').trim().slice(0, limit);

export function createTask({ title, text, assignee, recommendation, by = 'owner' }) {
  const body = cleanText(text, 8000);
  const name = cleanText(title, 140) || body.split('\n')[0].slice(0, 80);
  if (!body) throw new Error('The task is empty.');
  if (!agents.includes(assignee)) throw new Error(`Unknown agent: ${assignee}`);
  return withLock(() => {
    const store = readTasks();
    const now = new Date().toISOString();
    const task = {
      id: taskId(store.next),
      title: name,
      text: body,
      assignee,
      recommendation: recommendation ?? null,
      status: 'assigned',
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, by, status: 'assigned', note: `Assigned to ${assignee}` }],
    };
    store.next += 1;
    store.tasks.push(task);
    writeJson(tasksFile, store);
    return task;
  });
}

// Verification is evidence from someone else, so the assignee cannot verify their own work.
// The owner and the other agents can.
export function updateTask(id, { status, note, assignee, by }) {
  if (status !== undefined && !statuses.includes(status)) throw new Error(`Invalid status: ${status}. Valid: ${statuses.join(', ')}`);
  if (assignee !== undefined && !agents.includes(assignee)) throw new Error(`Unknown agent: ${assignee}`);
  return withLock(() => {
    const store = readTasks();
    const task = store.tasks.find(item => item.id === id && !item.archived);
    if (!task) throw new Error(`Task ${id} does not exist.`);
    if (status === 'verified' && by === task.assignee) throw new Error('The agent who did the task cannot verify it. Ask another agent or the owner.');
    const now = new Date().toISOString();
    if (status) task.status = status;
    if (assignee && assignee !== task.assignee) {
      task.assignee = assignee;
      if (!status) task.status = 'assigned';
    }
    if (status === 'verified') task.verifiedBy = by;
    if (status && status !== 'verified') delete task.verifiedBy;
    task.updatedAt = now;
    task.history.push({ at: now, by, status: task.status, assignee: task.assignee, note: cleanText(note, 600) || undefined });
    writeJson(tasksFile, store);
    return task;
  });
}

// The trash button does not delete: it archives verified tasks so they leave the list.
// The channel's message history does not change.
export function archiveVerified(by = 'owner') {
  return withLock(() => {
    const store = readTasks();
    const now = new Date().toISOString();
    let count = 0;
    for (const task of store.tasks) {
      if (task.archived || task.status !== 'verified') continue;
      task.archived = true;
      task.archivedAt = now;
      task.archivedBy = by;
      count += 1;
    }
    writeJson(tasksFile, store);
    return count;
  });
}

// What an agent declares about itself (model, effort, out of tokens) beats detection while it is
// recent, because the agent knows when it has just switched models.
export function clearDeclared(agent) {
  if (!agents.includes(agent)) throw new Error(`Unknown agent: ${agent}`);
  return withLock(() => {
    const declared = readDeclared();
    delete declared[agent];
    writeJson(declaredFile, declared);
  });
}

export function declareAgent(agent, { model, effort, outOfTokens, note }) {
  if (!agents.includes(agent)) throw new Error(`Unknown agent: ${agent}`);
  return withLock(() => {
    const declared = readDeclared();
    const entry = {
      at: new Date().toISOString(),
      model: cleanText(model, 80) || undefined,
      effort: cleanText(effort, 20) || undefined,
      outOfTokens: outOfTokens === true,
      note: cleanText(note, 300) || undefined,
    };
    declared[agent] = entry;
    writeJson(declaredFile, declared);
    return entry;
  });
}
