// Detección automática del modelo, el esfuerzo y la cuota de cada agente.
// Solo lee registros locales que ya escribe cada cliente; no llama a ningún servicio.
import { execFile } from 'node:child_process';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir, readDeclared } from './store.mjs';

const home = homedir();
const activeWindowMs = 15 * 60 * 1000;
const declaredValidMs = 6 * 60 * 60 * 1000;

async function tail(file, bytes = 384 * 1024) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

async function newest(files) {
  const withTimes = await Promise.all(files.map(async file => {
    try { return { file, mtime: (await stat(file)).mtimeMs }; } catch { return null; }
  }));
  return withTimes.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
}

async function listFiles(directory, test) {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && test(entry.name)).map(entry => join(directory, entry.name));
  } catch {
    return [];
  }
}

const jsonLines = text => text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

export function prettyModel(model) {
  if (!model) return null;
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i.exec(model);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
  return model;
}

// Permisos de cada agente: solo dos estados para la tarjeta, «Ilimitada» cuando actúa sin pedir
// aprobación ni sandbox, y «Controlado» en el resto; el modo concreto va en el detalle emergente.
const unlimited = 'Ilimitada';
const controlled = 'Controlado';
const claudeModes = { default: 'pide permiso', acceptEdits: 'edita sin preguntar', plan: 'solo plan', auto: 'auto', bypassPermissions: 'sin barreras', dontAsk: 'no pregunta' };
function claudePermission(mode) {
  if (!mode) return null;
  const open = mode === 'bypassPermissions' || mode === 'dontAsk';
  return { label: open ? unlimited : controlled, unlimited: open, detail: `Claude Code, modo «${claudeModes[mode] ?? mode}»` };
}

const codexSandboxes = { 'read-only': 'solo lectura', 'workspace-write': 'escritura en el proyecto', 'danger-full-access': 'acceso total' };
function codexPermission(turn) {
  const sandbox = turn?.sandbox_policy?.type;
  if (!sandbox) return null;
  const approval = turn.approval_policy ?? 'sin indicar';
  const open = sandbox === 'danger-full-access' && approval === 'never';
  return { label: open ? unlimited : controlled, unlimited: open, detail: `Codex, sandbox «${codexSandboxes[sandbox] ?? sandbox}», aprobación «${approval}»` };
}

async function geminiPermission() {
  try {
    const config = JSON.parse(await readFile(join(home, '.gemini', 'config', 'config.json'), 'utf8'));
    const allow = config.userSettings?.globalPermissionGrants?.allow ?? [];
    const open = allow.some(rule => rule === '*' || rule === '**');
    return { label: open ? unlimited : controlled, unlimited: open, detail: `Antigravity: ${allow.length} acciones aprobadas siempre; el resto pide confirmación` };
  } catch {
    return null;
  }
}

async function detectClaude() {
  const root = join(home, '.claude', 'projects');
  let projects = [];
  try { projects = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(root, entry.name)); } catch {}
  const files = (await Promise.all(projects.map(project => listFiles(project, name => name.endsWith('.jsonl'))))).flat();
  const [latest] = await newest(files);
  if (!latest) return { source: 'sin registros de Claude Code' };
  const raw = await tail(latest.file);
  const lines = jsonLines(raw);
  let model = null;
  let effort = null;
  let limitText = null;
  let permissionMode = null;
  let modelAt = null;
  for (const line of lines) {
    if (typeof line.effort === 'string') effort = line.effort;
    const message = line.message;
    if (message?.role !== 'assistant') continue;
    if (message.model && message.model !== '<synthetic>') {
      model = message.model;
      modelAt = line.timestamp ?? modelAt;
      limitText = null;
    } else if (message.model === '<synthetic>') {
      const text = (message.content ?? []).map(part => part?.text ?? '').join(' ');
      if (/limit|quota|cuota/i.test(text)) limitText = text.slice(0, 160);
    }
  }
  // El modo de permisos va en las líneas del usuario, que pueden quedar lejos del final o cortadas: se busca en el texto.
  const lastMode = text => [...text.matchAll(/"permissionMode":"([A-Za-z]+)"/g)].at(-1)?.[1] ?? null;
  permissionMode = lastMode(raw) ?? lastMode(await tail(latest.file, 8 * 1024 * 1024));
  // El porcentaje solo lo da la línea de estado de Claude Code (claude-statusline.mjs), que lo deja en data/.
  let usage = null;
  try { usage = JSON.parse(await readFile(join(dataDir, 'claude-usage.json'), 'utf8')); } catch {}
  const current = value => value && (!value.resetsAt || Date.parse(value.resetsAt) > Date.now()) ? value : null;
  const fiveHour = current(usage?.fiveHour);
  const sevenDay = current(usage?.sevenDay);
  const binding = [fiveHour, sevenDay].filter(Boolean).sort((a, b) => b.usedPercent - a.usedPercent)[0] ?? null;
  return {
    model,
    effort,
    usedPercent: binding ? binding.usedPercent : null,
    permission: claudePermission(permissionMode),
    resetsAt: binding?.resetsAt ?? null,
    usageDetail: fiveHour || sevenDay ? [fiveHour ? `5 h ${Math.round(fiveHour.usedPercent)} %` : null, sevenDay ? `7 días ${Math.round(sevenDay.usedPercent)} %` : null].filter(Boolean).join(' · ') : null,
    outOfTokens: Boolean(limitText) || (binding ? binding.usedPercent >= 100 : false),
    limitText,
    modelAt,
    lastActivity: new Date(latest.mtime).toISOString(),
    source: 'registro de Claude Code',
  };
}

async function detectCodex() {
  const root = join(home, '.codex', 'sessions');
  const files = [];
  for (let back = 0; back < 4; back++) {
    const day = new Date(Date.now() - back * 86_400_000);
    const directory = join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    files.push(...await listFiles(directory, name => name.startsWith('rollout-') && name.endsWith('.jsonl')));
  }
  const sorted = await newest(files);
  if (!sorted.length) return { source: 'sin sesiones recientes de Codex' };
  let model = null;
  let effort = null;
  let limits = null;
  let turn = null;
  let modelAt = null;
  for (const { file } of sorted.slice(0, 5)) {
    // El último turno principal del archivo más reciente que lo tenga; los turnos de revisión automática no cuentan.
    // En sesiones largas el turno queda lejos del final: si el último tramo no lo trae, se lee uno mayor.
    const mainTurns = lines => lines.filter(line => line.type === 'turn_context' && line.payload?.model && !/auto-review/i.test(line.payload.model));
    let lines = jsonLines(await tail(file));
    let contexts = mainTurns(lines);
    if (!model && !contexts.length) {
      lines = jsonLines(await tail(file, 8 * 1024 * 1024));
      contexts = mainTurns(lines);
    }
    if (!model && contexts.length) {
      const last = contexts.at(-1).payload;
      model = last.model;
      effort = last.effort ?? last.reasoning_effort ?? null;
      modelAt = contexts.at(-1).timestamp ?? null;
      turn = last;
    }
    if (!limits) {
      const withLimits = lines.filter(line => line.payload?.rate_limits?.primary);
      if (withLimits.length) limits = withLimits.at(-1).payload.rate_limits;
    }
    if (model && limits) break;
  }
  // Si el modelo se cambia en la configuración de Codex después del último turno, manda la configuración.
  let source = 'sesiones de Codex';
  try {
    const configFile = join(home, '.codex', 'config.toml');
    const changed = (await stat(configFile)).mtimeMs;
    if (!modelAt || changed > Date.parse(modelAt) + 2000) {
      const config = await readFile(configFile, 'utf8');
      const configModel = /^model\s*=\s*"([^"]+)"/m.exec(config)?.[1];
      const configEffort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(config)?.[1];
      if (configModel) {
        model = configModel;
        effort = configEffort ?? effort;
        modelAt = new Date(changed).toISOString();
        source = 'configuración de Codex';
      }
    }
  } catch {}
  const used = limits?.primary?.used_percent ?? null;
  return {
    model,
    effort,
    modelAt,
    permission: codexPermission(turn),
    usedPercent: typeof used === 'number' ? used : null,
    resetsAt: limits?.primary?.resets_at ? new Date(limits.primary.resets_at * 1000).toISOString() : null,
    outOfTokens: Boolean(limits?.rate_limit_reached_type) || (typeof used === 'number' && used >= 100),
    lastActivity: new Date(sorted[0].mtime).toISOString(),
    source,
  };
}

// Gemini participa por la CLI agy o por la aplicación de escritorio Antigravity.
// En Windows se consulta tasklist; en macOS y Linux, ps.
const runningGemini = () => new Promise(resolve => {
  const windows = process.platform === 'win32';
  const [command, args] = windows ? ['tasklist', ['/FO', 'CSV', '/NH']] : ['ps', ['-A', '-o', 'comm=']];
  execFile(command, args, { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    if (error) return resolve(null);
    const names = stdout.split(/\r?\n/).map(line => (windows ? line.split(',')[0].replaceAll('"', '') : line.split('/').pop()).trim().toLowerCase());
    if (names.some(name => name === 'agy' || name === 'agy.exe')) return resolve('agy');
    resolve(names.some(name => name.startsWith('antigravity')) ? 'Antigravity' : null);
  });
});

async function detectGemini() {
  const logs = await newest(await listFiles(dataDir, name => /^gemini.*\.log$/i.test(name)));
  const running = await runningGemini();
  const permission = await geminiPermission();
  if (!logs.length) return { running, permission, source: 'sin registros de Gemini' };
  const text = await tail(logs[0].file, 1024 * 1024);
  const resolved = [...text.matchAll(/Resolving model (\S+)/g)];
  const variant = resolved.at(-1)?.[1] ?? null;
  const afterModel = resolved.length ? text.slice(resolved.at(-1).index) : text;
  const exhausted = /RESOURCE_EXHAUSTED|\b429\b/.test(afterModel);
  const parts = /^(.*?)-(low|medium|high)$/i.exec(variant ?? '');
  return {
    model: parts ? parts[1] : variant,
    effort: parts ? parts[2].toLowerCase() : null,
    outOfTokens: exhausted,
    running,
    permission,
    modelAt: new Date(logs[0].mtime).toISOString(),
    lastActivity: new Date(logs[0].mtime).toISOString(),
    source: running === 'Antigravity' ? 'Antigravity abierto: el modelo sale del último registro de agy o de lo que se declare' : 'registro de agy',
  };
}

function merge(name, detected, declared) {
  const result = { name, ...detected, declared: null };
  const fresh = declared && Date.now() - Date.parse(declared.at) < declaredValidMs;
  if (fresh) {
    // Lo declarado manda hasta que el registro del agente muestre un modelo con evidencia más reciente.
    const newerThanDetection = !detected.modelAt || Date.parse(declared.at) > Date.parse(detected.modelAt);
    if (declared.model && newerThanDetection) result.model = declared.model;
    if (declared.effort && newerThanDetection) result.effort = declared.effort;
    if (declared.outOfTokens) result.outOfTokens = true;
    result.declared = declared;
  }
  const active = name === 'gemini' ? Boolean(detected.running) : Boolean(detected.lastActivity && Date.now() - Date.parse(detected.lastActivity) < activeWindowMs);
  result.state = result.outOfTokens ? 'sin_tokens' : active ? 'activo' : result.model ? 'inactivo' : 'desconocido';
  result.label = prettyModel(result.model);
  return result;
}

export async function detectAgents() {
  const declared = readDeclared();
  const safe = promise => promise.catch(error => ({ source: `error: ${error.message}` }));
  const [claude, codex, gemini] = await Promise.all([safe(detectClaude()), safe(detectCodex()), safe(detectGemini())]);
  return {
    claude: merge('claude', claude, declared.claude),
    codex: merge('codex', codex, declared.codex),
    gemini: merge('gemini', gemini, declared.gemini),
  };
}

export const modelTag = agent => agent?.label ? `${agent.label}${agent.effort ? ` (${agent.effort})` : ''}` : undefined;
