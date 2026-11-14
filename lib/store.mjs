// Almacén compartido de tareas y estado declarado de agentes.
// Lo usan channel.mjs (MCP y CLI de cada agente) y ventana.mjs (la ventana del propietario),
// que son procesos distintos: cada escritura toma un candado de directorio y reemplaza el archivo entero.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = process.env.AGENT_CHANNEL_DATA ?? join(root, 'data');
export const tasksFile = join(dataDir, 'tasks.json');
export const declaredFile = join(dataDir, 'agents.json');
const lockDir = join(dataDir, '.store.lock');

export const agents = ['claude', 'codex', 'gemini'];
export const statuses = ['asignada', 'en_curso', 'terminada', 'verificada', 'bloqueada'];
export const efforts = ['bajo', 'medio', 'alto'];

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
      if (Date.now() - started > 5000) throw new Error('El almacén de tareas está ocupado. Inténtalo de nuevo.');
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

export function createTask({ title, text, assignee, recommendation, by = 'propietario' }) {
  const body = cleanText(text, 8000);
  const name = cleanText(title, 140) || body.split('\n')[0].slice(0, 80);
  if (!body) throw new Error('La tarea está vacía.');
  if (!agents.includes(assignee)) throw new Error(`Agente desconocido: ${assignee}`);
  return withLock(() => {
    const store = readTasks();
    const now = new Date().toISOString();
    const task = {
      id: taskId(store.next),
      title: name,
      text: body,
      assignee,
      recommendation: recommendation ?? null,
      status: 'asignada',
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, by, status: 'asignada', note: `Asignada a ${assignee}` }],
    };
    store.next += 1;
    store.tasks.push(task);
    writeJson(tasksFile, store);
    return task;
  });
}

// Reglas de verificación: verificar es evidencia de otra parte, así que quien tiene la tarea
// asignada no puede verificar su propio trabajo. Sí pueden el propietario y los demás agentes.
export function updateTask(id, { status, note, assignee, by }) {
  if (status !== undefined && !statuses.includes(status)) throw new Error(`Estado no válido: ${status}. Válidos: ${statuses.join(', ')}`);
  if (assignee !== undefined && !agents.includes(assignee)) throw new Error(`Agente desconocido: ${assignee}`);
  return withLock(() => {
    const store = readTasks();
    const task = store.tasks.find(item => item.id === id && !item.archived);
    if (!task) throw new Error(`No existe la tarea ${id}.`);
    if (status === 'verificada' && by === task.assignee) throw new Error('Quien hizo la tarea no puede verificarla. Pide la verificación a otro agente o al propietario.');
    const now = new Date().toISOString();
    if (status) task.status = status;
    if (assignee && assignee !== task.assignee) {
      task.assignee = assignee;
      if (!status) task.status = 'asignada';
    }
    if (status === 'verificada') task.verifiedBy = by;
    if (status && status !== 'verificada') delete task.verifiedBy;
    task.updatedAt = now;
    task.history.push({ at: now, by, status: task.status, assignee: task.assignee, note: cleanText(note, 600) || undefined });
    writeJson(tasksFile, store);
    return task;
  });
}

// La papelera no borra: archiva las tareas verificadas, que salen de la lista.
// El historial de mensajes del canal no cambia.
export function archiveVerified(by = 'propietario') {
  return withLock(() => {
    const store = readTasks();
    const now = new Date().toISOString();
    let count = 0;
    for (const task of store.tasks) {
      if (task.archived || task.status !== 'verificada') continue;
      task.archived = true;
      task.archivedAt = now;
      task.archivedBy = by;
      count += 1;
    }
    writeJson(tasksFile, store);
    return count;
  });
}

// Lo que un agente declara de sí mismo (modelo, esfuerzo, sin tokens) prevalece sobre la detección
// mientras sea reciente, porque el agente sabe si acaba de cambiar de modelo.
export function clearDeclared(agent) {
  if (!agents.includes(agent)) throw new Error(`Agente desconocido: ${agent}`);
  return withLock(() => {
    const declared = readDeclared();
    delete declared[agent];
    writeJson(declaredFile, declared);
  });
}

export function declareAgent(agent, { model, effort, outOfTokens, note }) {
  if (!agents.includes(agent)) throw new Error(`Agente desconocido: ${agent}`);
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
