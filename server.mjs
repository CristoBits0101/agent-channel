// Agent channel window: a local server, only on 127.0.0.1, that serves the interface,
// streams live state (Server-Sent Events) and receives the owner's tasks and messages.
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
// Everything the owner sends from the window is signed, so agents recognize it as the owner's orders.
const sign = ownerSigner();
const assets = new Map([
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  // The Gemini logo is not in the repository: the launcher downloads it into the data folder.
  ['/gemini.png', [join(dataDir, 'gemini.png'), 'image/png']],
  ['/logos.js', ['logos.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/google-sans-flex-latin.woff2', [join('assets', 'fonts', 'google-sans-flex-latin.woff2'), 'font/woff2']],
  ['/google-sans-flex-latin-ext.woff2', [join('assets', 'fonts', 'google-sans-flex-latin-ext.woff2'), 'font/woff2']],
  ['/dancing-script.woff2', [join('assets', 'fonts', 'dancing-script.woff2'), 'font/woff2']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
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
  // The agent channel (messages without a task) sends its last 200; each visible task sends all of its own.
  const channelSeqs = new Set(all.filter(message => !messageTask(message)).slice(-channelLimit).map(message => message.seq));
  const messages = all.filter(message => channelSeqs.has(message.seq) || visible.has(messageTask(message)))
    .map(message => ({ seq: message.seq, at: message.at, from: message.from, to: message.to, text: message.text, model: message.model ?? null, task: messageTask(message), signed: isOwnerSigned(message) }));
  return { agents: agentInfo, tasks, messages, statuses };
}

// A change in the history, the tasks or what an agent declared is broadcast to every open window.
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
// What an agent or the owner declares applies within a second; log detection runs every 8 s.
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
setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 25_000).unref();

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('The message is too long.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

function taskMessage(task, recommendation) {
  const lines = [`@${task.assignee} [${task.id}] New task: ${task.title}`, '', task.text, ''];
  if (recommendation?.agent) {
    lines.push(`Orchestrator: ${recommendation.agent} · ${recommendation.model} · effort ${recommendation.effort} (complexity ${recommendation.level}). Reason: ${recommendation.reasons.join('; ')}.`);
  }
  lines.push(`Reply in this task with channel_post and task "${task.id}". When you finish, use task_update with status "done" and a note with the evidence; another agent or the owner verifies it.`);
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
  if (request.method !== 'POST') return respond(response, 405, { error: 'Method not allowed.' });
  if (request.headers['x-window-token'] !== token || !String(request.headers['content-type'] ?? '').startsWith('application/json')) {
    return respond(response, 403, { error: 'Request not allowed.' });
  }
  const body = await readBody(request);
  if (url.pathname === '/api/recommend') return respond(response, 200, recommend(body.text, agentInfo, readTasks().tasks));
  if (url.pathname === '/api/tasks') {
    const advice = recommend(`${body.title ?? ''}\n${body.text ?? ''}`, agentInfo, readTasks().tasks);
    const assignee = agents.includes(body.assignee) ? body.assignee : advice.agent;
    if (!assignee) return respond(response, 409, { error: 'No agent has tokens available. Pick one by hand.' });
    const task = createTask({ title: body.title, text: body.text, assignee, recommendation: advice });
    postMessage('owner', taskMessage(task, assignee === advice.agent ? advice : { ...advice, agent: null }), assignee, { task: task.id, sign });
    await broadcast(true);
    return respond(response, 201, { task });
  }
  if (url.pathname === '/api/channel') {
    const to = ['all', ...agents].includes(body.to) ? body.to : 'all';
    const seq = postMessage('owner', body.text, to, { sign });
    await broadcast(true);
    return respond(response, 201, { seq });
  }
  const agentMatch =/^\/api\/agents\/(claude|codex|gemini)$/.exec(url.pathname);
  if (agentMatch) {
    if (body.clear === true) clearDeclared(agentMatch[1]);
    else declareAgent(agentMatch[1], { model: body.model, effort: body.effort, outOfTokens: body.outOfTokens === true, note: 'Set by the owner in the window' });
    await refreshAgents();
    return respond(response, 200, { agent: agentInfo[agentMatch[1]] });
  }
  if (url.pathname === '/api/tasks/clear') {
    const archived = archiveVerified('owner');
    await broadcast(true);
    return respond(response, 200, { archived });
  }
  const match = /^\/api\/tasks\/(T-\d{3,})\/(messages|status)$/.exec(url.pathname);
  if (match) {
    const task = findTask(match[1]);
    if (!task) return respond(response, 404, { error: `Task ${match[1]} does not exist.` });
    if (match[2] === 'messages') {
      const seq = postMessage('owner', body.text, task.assignee, { task: task.id, sign });
      await broadcast(true);
      return respond(response, 201, { seq });
    }
    const assignee = agents.includes(body.assignee) && body.assignee !== task.assignee ? body.assignee : undefined;
    const updated = updateTask(task.id, { status: body.status, assignee, note: body.note, by: 'owner' });
    const text = assignee
      ? `@${assignee} [${task.id}] I am reassigning this task to you: ${task.title}\n\n${task.text}\n\nReply with channel_post and task "${task.id}"; when you finish, use task_update with status "done".`
      : `${task.id} status: ${updated.status}${body.note ? `\n${body.note}` : ''}`;
    postMessage('owner', text, assignee ?? updated.assignee, { task: task.id, sign });
    await broadcast(true);
    return respond(response, 200, { task: updated });
  }
  return respond(response, 404, { error: 'Route not found.' });
}

const server = createServer(async (request, response) => {
  const requestOrigin = request.headers.origin;
  if (request.headers.host !== address || (requestOrigin && requestOrigin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') {
    return respond(response, 403, 'Request not allowed.', 'text/plain; charset=utf-8');
  }
  const url = new URL(request.url ?? '/', origin);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (request.method !== 'GET') return respond(response, 405, 'Method not allowed.', 'text/plain; charset=utf-8');
    if (url.pathname === '/') {
      const html = (await readFile(join(directory, 'index.html'), 'utf8')).replace('__TOKEN__', token);
      return respond(response, 200, html, 'text/html; charset=utf-8');
    }
    if (assets.has(url.pathname)) {
      const [file, type] = assets.get(url.pathname);
      return respond(response, 200, await readFile(resolve(directory, file)), type);
    }
    return respond(response, 404, 'Page not found.', 'text/plain; charset=utf-8');
  } catch (error) {
    if (!response.headersSent) respond(response, error.status ?? (error.code === 'ENOENT' ? 404 : 400), { error: error.code === 'ENOENT' ? 'Not found.' : error.message });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 10_000;
server.on('error', error => {
  process.stderr.write(`Could not start the window: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`Agent channel window: ${origin}/ · PID ${process.pid}\n`));
