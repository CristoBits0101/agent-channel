// Ventana del canal de agentes: servidor local solo en 127.0.0.1 que sirve la interfaz,
// emite el estado en vivo (Server-Sent Events) y recibe las tareas y mensajes del propietario.
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAgents } from './lib/detect.mjs';
import { channelFile, messageTask, postMessage, readMessages } from './lib/messages.mjs';
import { recommend } from './lib/orchestrator.mjs';
import { isOwnerSigned, ownerSigner } from './lib/owner.mjs';
import { agents, archiveVerified, clearDeclared, createTask, dataDir, declareAgent, declaredFile, readTasks, statuses, tasksFile, updateTask } from './lib/store.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.AGENT_WINDOW_PORT || 18544);
const address = `127.0.0.1:${port}`;
const origin = `http://${address}`;
const token = randomBytes(24).toString('hex');
const channelLimit = 200;
// Todo lo que el propietario envía desde la ventana va firmado: los agentes lo reconocen como orden suya.
const sign = ownerSigner();
const assets = new Map([
  ['/ventana.js', ['ventana.js', 'text/javascript; charset=utf-8']],
  ['/ventana.css', ['ventana.css', 'text/css; charset=utf-8']],
  ['/icono.svg', ['icono.svg', 'image/svg+xml']],
  // El logotipo de Gemini no va en el repositorio: el lanzador lo descarga en la carpeta de datos.
  ['/gemini.png', [join(dataDir, 'gemini.png'), 'image/png']],
  ['/logos.js', ['logos.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/google-sans-flex-latin.woff2', [join('assets', 'fonts', 'google-sans-flex-latin.woff2'), 'font/woff2']],
  ['/google-sans-flex-latin-ext.woff2', [join('assets', 'fonts', 'google-sans-flex-latin-ext.woff2'), 'font/woff2']],
  ['/dancing-script.woff2', [join('assets', 'fonts', 'dancing-script.woff2'), 'font/woff2']],
  ['/icono-192.png', ['icono-192.png', 'image/png']],
  ['/icono-512.png', ['icono-512.png', 'image/png']],
]);

const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

const respond = (response, status, body, type = 'application/json; charset=utf-8') => {
  response.writeHead(status, { ...headers, 'Content-Type': type });
  response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

let agentInfo = await detectAgents();

function snapshot() {
  const tasks = readTasks().tasks.filter(task => !task.archived);
  const visible = new Set(tasks.map(task => task.id));
  const all = readMessages(0).filter(message => message.text);
  // El canal de agentes (mensajes sin tarea) envía sus últimos 200; cada tarea visible, todos los suyos.
  const channelSeqs = new Set(all.filter(message => !messageTask(message)).slice(-channelLimit).map(message => message.seq));
  const messages = all.filter(message => channelSeqs.has(message.seq) || visible.has(messageTask(message)))
    .map(message => ({ seq: message.seq, at: message.at, from: message.from, to: message.to, text: message.text, model: message.model ?? null, task: messageTask(message), signed: isOwnerSigned(message) }));
  return { agents: agentInfo, tasks, messages, statuses };
}

// Un cambio en el historial, las tareas o lo declarado por un agente se emite a todas las ventanas abiertas.
const clients = new Set();
let lastSignature = '';
async function signature() {
  const parts = await Promise.all([channelFile, tasksFile, declaredFile].map(async file => {
    try { const info = await stat(file); return `${info.size}:${info.mtimeMs}`; } catch { return '0'; }
  }));
  return `${parts.join('|')}|${JSON.stringify(agentInfo)}`;
}
async function broadcast(force = false) {
  const current = await signature();
  if (!force && current === lastSignature) return;
  lastSignature = current;
  if (!clients.size) return;
  const payload = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
  for (const client of clients) client.write(payload);
}
// Lo que declara un agente o el propietario se aplica en el siguiente segundo; la detección por registros cada 8 s.
let declaredStamp = '';
async function refreshAgents() {
  agentInfo = await detectAgents();
  await broadcast();
}
setInterval(async () => {
  try {
    const info = await stat(declaredFile).catch(() => null);
    const stamp = info ? `${info.size}:${info.mtimeMs}` : '0';
    if (stamp !== declaredStamp) { declaredStamp = stamp; await refreshAgents(); }
    else await broadcast();
  } catch {}
}, 1000).unref();
setInterval(() => refreshAgents().catch(() => {}), 8000).unref();
setInterval(() => { for (const client of clients) client.write(': latido\n\n'); }, 25_000).unref();

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('El mensaje es demasiado largo.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('JSON no válido.'), { status: 400 }); }
}

function taskMessage(task, recommendation) {
  const lines = [`@${task.assignee} [${task.id}] Nueva tarea: ${task.title}`, '', task.text, ''];
  if (recommendation?.agent) {
    lines.push(`Orquestador: ${recommendation.agent} · ${recommendation.model} · esfuerzo ${recommendation.effort} (complejidad ${recommendation.level}). Motivo: ${recommendation.reasons.join('; ')}.`);
  }
  lines.push(`Responde en esta tarea con channel_post y task "${task.id}". Al acabar usa task_update con status "terminada" y una nota con la evidencia; la verificación la hace otro agente o el propietario.`);
  return lines.join('\n');
}

const findTask = id => readTasks().tasks.find(task => task.id === id && !task.archived);

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/state') return respond(response, 200, snapshot());
  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    response.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  if (request.method !== 'POST') return respond(response, 405, { error: 'Método no permitido.' });
  if (request.headers['x-ventana-token'] !== token || !String(request.headers['content-type'] ?? '').startsWith('application/json')) {
    return respond(response, 403, { error: 'Solicitud no permitida.' });
  }
  const body = await readBody(request);
  if (url.pathname === '/api/recommend') return respond(response, 200, recommend(body.text, agentInfo, readTasks().tasks));
  if (url.pathname === '/api/tasks') {
    const advice = recommend(`${body.title ?? ''}\n${body.text ?? ''}`, agentInfo, readTasks().tasks);
    const assignee = agents.includes(body.assignee) ? body.assignee : advice.agent;
    if (!assignee) return respond(response, 409, { error: 'Ningún agente tiene tokens disponibles. Elige uno a mano.' });
    const task = createTask({ title: body.title, text: body.text, assignee, recommendation: advice });
    postMessage('propietario', taskMessage(task, assignee === advice.agent ? advice : { ...advice, agent: null }), assignee, { task: task.id, sign });
    await broadcast(true);
    return respond(response, 201, { task });
  }
  if (url.pathname === '/api/channel') {
    const to = ['todos', ...agents].includes(body.to) ? body.to : 'todos';
    const seq = postMessage('propietario', body.text, to, { sign });
    await broadcast(true);
    return respond(response, 201, { seq });
  }
  const agentMatch =/^\/api\/agents\/(claude|codex|gemini)$/.exec(url.pathname);
  if (agentMatch) {
    if (body.clear === true) clearDeclared(agentMatch[1]);
    else declareAgent(agentMatch[1], { model: body.model, effort: body.effort, outOfTokens: body.outOfTokens === true, note: 'Fijado por el propietario en la ventana' });
    await refreshAgents();
    return respond(response, 200, { agent: agentInfo[agentMatch[1]] });
  }
  if (url.pathname === '/api/tasks/clear') {
    const archived = archiveVerified('propietario');
    await broadcast(true);
    return respond(response, 200, { archived });
  }
  const match = /^\/api\/tasks\/(T-\d{3,})\/(messages|status)$/.exec(url.pathname);
  if (match) {
    const task = findTask(match[1]);
    if (!task) return respond(response, 404, { error: `No existe la tarea ${match[1]}.` });
    if (match[2] === 'messages') {
      const seq = postMessage('propietario', body.text, task.assignee, { task: task.id, sign });
      await broadcast(true);
      return respond(response, 201, { seq });
    }
    const assignee = agents.includes(body.assignee) && body.assignee !== task.assignee ? body.assignee : undefined;
    const updated = updateTask(task.id, { status: body.status, assignee, note: body.note, by: 'propietario' });
    const text = assignee
      ? `@${assignee} [${task.id}] Te reasigno esta tarea: ${task.title}\n\n${task.text}\n\nResponde con channel_post y task "${task.id}"; al acabar usa task_update con status "terminada".`
      : `Estado de ${task.id}: ${updated.status}${body.note ? `\n${body.note}` : ''}`;
    postMessage('propietario', text, assignee ?? updated.assignee, { task: task.id, sign });
    await broadcast(true);
    return respond(response, 200, { task: updated });
  }
  return respond(response, 404, { error: 'Ruta no encontrada.' });
}

const server = createServer(async (request, response) => {
  const requestOrigin = request.headers.origin;
  if (request.headers.host !== address || (requestOrigin && requestOrigin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') {
    return respond(response, 403, 'Solicitud no permitida.', 'text/plain; charset=utf-8');
  }
  const url = new URL(request.url ?? '/', origin);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (request.method !== 'GET') return respond(response, 405, 'Método no permitido.', 'text/plain; charset=utf-8');
    if (url.pathname === '/') {
      const html = (await readFile(join(directory, 'ventana.html'), 'utf8')).replace('__TOKEN__', token);
      return respond(response, 200, html, 'text/html; charset=utf-8');
    }
    if (assets.has(url.pathname)) {
      const [file, type] = assets.get(url.pathname);
      return respond(response, 200, await readFile(resolve(directory, file)), type);
    }
    return respond(response, 404, 'Página no encontrada.', 'text/plain; charset=utf-8');
  } catch (error) {
    if (!response.headersSent) respond(response, error.status ?? 400, { error: error.message });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 10_000;
server.on('error', error => {
  process.stderr.write(`No se pudo iniciar la ventana: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`Ventana del canal: ${origin}/ · PID ${process.pid}\n`));
