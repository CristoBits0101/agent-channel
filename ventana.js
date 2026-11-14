'use strict';

const token = document.querySelector('meta[name="ventana-token"]').content;
const $ = selector => document.querySelector(selector);
const names = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', propietario: 'Propietario', todos: 'Todos' };
const stateNames = { activo: 'Activo', inactivo: 'Inactivo', sin_tokens: 'Sin tokens', desconocido: 'Sin datos' };
const statusNames = { asignada: 'Asignada', en_curso: 'En curso', terminada: 'Terminada · por verificar', verificada: 'Verificada', bloqueada: 'Bloqueada' };
// Hora local del equipo de cada usuario.
const zone = undefined;
const dayFormat = new Intl.DateTimeFormat('es-ES', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('es-ES', { timeZone: zone, hour: '2-digit', minute: '2-digit' });
const shortDayFormat = new Intl.DateTimeFormat('es-ES', { timeZone: zone, day: '2-digit', month: '2-digit' });
const fullFormat = new Intl.DateTimeFormat('es-ES', { timeZone: zone, dateStyle: 'full', timeStyle: 'medium' });

const params = new URLSearchParams(location.search);
const solo = /^T-\d{3,}$/.test(params.get('task') ?? '') ? params.get('task') : null;
if (solo) document.body.dataset.solo = '';

let data = { agents: {}, tasks: [], messages: [] };
// La vista principal es el canal de agentes; cada tarea abre su propio chat.
let view = solo ? { type: 'task', id: solo } : { type: 'channel' };
let previous = view;
let loaded = false;
let renderedKey = '';

const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};
const seen = storage.get('ventana-seen') ?? {};
const conversationKey = current => current.id ?? current.type;

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('data-')) node.dataset[key.slice(5).replace(/-(\w)/g, (_, letter) => letter.toUpperCase())] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
  return node;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { short: '', full: '' };
  const today = dayFormat.format(new Date()) === dayFormat.format(date);
  return { short: today ? timeFormat.format(date) : `${shortDayFormat.format(date)} ${timeFormat.format(date)}`, full: fullFormat.format(date) };
}

async function api(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ventana-Token': token }, body: JSON.stringify(body ?? {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `Error ${response.status}`);
  return result;
}

const announce = text => { $('#announce').textContent = ''; requestAnimationFrame(() => { $('#announce').textContent = text; }); };
const messagesOf = current => data.messages.filter(message => current.type === 'task' ? message.task === current.id : !message.task);
const findTask = id => data.tasks.find(task => task.id === id);

// Los agentes llevan el logotipo oficial de su compañía (logos.js); el propietario, sus iniciales.
function logo(who) {
  // El logotipo de Gemini no se redistribuye: el lanzador lo descarga de Google en la carpeta de datos.
  if (who === 'gemini') {
    const image = element('img', { src: '/gemini.png', alt: '', width: '18', height: '18' });
    image.addEventListener('error', () => image.replaceWith(document.createTextNode('Ge')), { once: true });
    return image;
  }
  const path = window.agentLogos?.[who];
  if (!path) return document.createTextNode(who === 'propietario' ? 'Tú' : String(who).slice(0, 2));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('focusable', 'false');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}
const avatar = (who, withState = false) => element('span', { class: 'avatar', 'data-who': who, 'aria-hidden': 'true' }, logo(who), withState ? element('span', { class: 'state' }) : null);

// Solo se vuelve a pintar lo que cambia, para no perder el foco ni el clic mientras llega el estado en vivo.
const painted = {};
const changed = (part, value) => {
  const key = JSON.stringify(value);
  if (painted[part] === key) return false;
  painted[part] = key;
  return true;
};

function renderAgents() {
  const list = $('#agents');
  if (!changed('agents', ['claude', 'codex', 'gemini'].map(name => {
    const { state, label, effort, usedPercent, source, declared, resetsAt, limitText, model, usageDetail, permission } = data.agents[name] ?? {};
    return [state, label, effort, usedPercent, source, declared?.at, resetsAt, limitText, model, usageDetail, permission?.label];
  }))) return;
  list.replaceChildren(...['claude', 'codex', 'gemini'].map(name => {
    const info = data.agents[name] ?? {};
    const state = stateNames[info.state] ?? 'Sin datos';
    const model = info.state === 'sin_tokens' ? `Sin tokens · ${info.label ?? ''}` : info.label ? `${info.label}${info.effort ? ` · ${info.effort}` : ''}` : 'Modelo sin detectar';
    const used = typeof info.usedPercent === 'number' ? Math.max(0, Math.min(100, Math.round(info.usedPercent))) : null;
    const quotaNote = info.usageDetail ? `uso ${info.usageDetail}` : used === null ? (name === "gemini" ? "Antigravity no expone su cuota" : "sin datos de cuota") : null;
    const details = [state, quotaNote, info.permission?.detail, info.source, info.declared ? `fijado ${formatTime(info.declared.at).short}` : null, info.resetsAt ? `cuota se renueva ${formatTime(info.resetsAt).short}` : null, info.limitText].filter(Boolean).join(' · ');
    const button = element('button', { type: 'button', class: 'agent', 'data-state': info.state ?? 'desconocido', 'data-agent': name, title: details, 'aria-label': `${names[name]}: ${model}. ${state}${used !== null ? `. Cuota usada ${used} %` : ''}. ${info.permission?.label ?? 'Permisos sin datos'}. Cambiar modelo` },
      avatar(name, true),
      element('span', { class: 'agent-info' },
        element('span', { class: 'agent-line' },
          element('span', { class: 'agent-name', text: names[name] }),
          element('span', { class: 'agent-permission', title: info.permission?.detail ?? 'Permisos sin detectar', text: info.permission?.label ?? 'Sin datos' })),
        element('span', { class: 'agent-line' },
          element('span', { class: 'agent-model', text: model }),
          usage(used, name))));
    return element('li', {}, button);
  }));
}

// Uso de cuota: barra fina y porcentaje usado; sin datos lo dice en lugar de inventar un número.
function usage(used, name) {
  if (used === null) return element('span', { class: 'agent-usage', 'data-level': 'none', title: name === 'gemini' ? 'Antigravity no expone su cuota' : 'Sin datos de cuota', text: 'Sin datos' });
  const bar = element('span', { class: 'usage-bar', 'aria-hidden': 'true' }, element('span'));
  bar.firstChild.style.width = `${used}%`;
  return element('span', { class: 'agent-usage', 'data-level': used >= 85 ? 'high' : 'normal', title: `${used} % de la cuota usado` }, bar, `${used} %`);
}

function openAgentDialog(name) {
  const info = data.agents[name] ?? {};
  const dialog = $('#agent-dialog');
  dialog.dataset.agent = name;
  $('#agent-dialog-title').textContent = `Modelo de ${names[name]}`;
  $('#agent-source').textContent = info.declared ? `Fijado a mano ${formatTime(info.declared.at).short}. Detección: ${info.source ?? 'sin datos'}.` : `Detectado desde: ${info.source ?? 'sin datos'}.`;
  $('#agent-model').value = info.model ?? '';
  $('#agent-effort').value = ['low', 'medium', 'high', 'xhigh', 'ultra'].includes(info.effort) ? info.effort : '';
  $('#agent-out').checked = info.state === 'sin_tokens';
  dialog.showModal();
}

function unreadCount(key, messages) {
  const last = seen[key] ?? 0;
  return messages.filter(message => message.seq > last && message.from !== 'propietario').length;
}

function renderTasks() {
  const list = $('#tasks');
  if (!changed('tasks', [view, data.tasks.map(task => [task.id, task.title, task.status, task.assignee]), data.messages.at(-1)?.seq, seen])) return;
  const ordered = [...data.tasks].sort((a, b) => (a.status === 'verificada') - (b.status === 'verificada') || a.id.localeCompare(b.id));
  list.replaceChildren(...ordered.map(task => {
    const unread = view.type === 'task' && view.id === task.id ? 0 : unreadCount(task.id, messagesOf({ type: 'task', id: task.id }));
    const button = element('button', { type: 'button', class: 'task-link', 'data-status': task.status, 'data-id': task.id, 'aria-current': view.type === 'task' && view.id === task.id ? 'true' : 'false' },
      element('span', { class: 'task-mark', 'aria-hidden': 'true', text: task.status === 'verificada' ? '✓' : '' }),
      element('span', { class: 'task-body' },
        element('span', { class: 'task-title', text: task.title }),
        element('span', { class: 'task-meta' },
          element('span', { text: `${task.id} · ${names[task.assignee]} · ${statusNames[task.status] ?? task.status}` }),
          unread ? element('span', { class: 'unread', text: String(unread), 'aria-label': `${unread} mensajes sin leer` }) : null)));
    return element('li', {}, button);
  }));
  $('#no-tasks').hidden = data.tasks.length > 0;
  $('#clear').disabled = !data.tasks.some(task => task.status === 'verificada');
  const open = data.tasks.filter(task => task.status !== 'verificada').length;
  $('#task-count').textContent = data.tasks.length ? String(data.tasks.length) : '';
  $('#task-count').setAttribute('aria-label', `${data.tasks.length} tareas, ${open} abiertas`);
}

function messageNode(message) {
  const time = formatTime(message.at);
  const sender = element('span', { class: 'sender' }, names[message.from] ?? message.from);
  if (message.model) sender.append(' ', element('span', { class: 'version', text: `· ${message.model}` }));
  if (message.from === 'propietario') sender.append(' ', element('span', { class: 'version', text: message.signed ? '· desde la ventana' : '· sin firma (consola)' }));
  if (message.to && message.to !== 'todos') sender.append(' ', element('span', { class: 'to', text: `→ ${names[message.to] ?? message.to}` }));
  return element('li', { class: 'message', 'data-from': message.from, 'data-seq': String(message.seq) },
    avatar(message.from),
    element('div', { class: 'message-main' },
      element('div', { class: 'message-head' }, sender, element('time', { class: 'time', datetime: message.at, title: time.full, text: time.short })),
      element('div', { class: 'message-text' }, formatText(message.text))));
}

// Formato del texto de los mensajes, construido con nodos (nunca innerHTML): bloques ``` de código,
// listas con «- », «1.» o «1)», enumeraciones en línea «1) … 2) …», párrafos, `código`, **negrita** y @menciones.
function inlineFormat(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(^|[\s(])(@(?:todos|claude|codex|gemini|propietario))\b/gi;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    let start = match.index;
    if (match[4]) start += match[3].length;
    if (start > last) fragment.append(text.slice(last, start));
    if (match[1] !== undefined) fragment.append(element('code', { text: match[1] }));
    else if (match[2] !== undefined) fragment.append(element('strong', { text: match[2] }));
    else fragment.append(element('span', { class: 'mention', text: match[4] }));
    last = match.index + match[0].length;
  }
  if (last < text.length) fragment.append(text.slice(last));
  return fragment;
}

function withBreaks(text) {
  const fragment = document.createDocumentFragment();
  text.split('\n').forEach((line, index) => {
    if (index) fragment.append(element('br'));
    fragment.append(inlineFormat(line));
  });
  return fragment;
}

// «Intro: 1) uno 2) dos» → intro y lista, solo si los números van seguidos desde 1.
function inlineEnumeration(text) {
  const marks = [...text.matchAll(/(^|\s)(\d{1,2})\)\s/g)];
  if (marks.length < 2) return null;
  let expected = 1;
  const items = [];
  for (const mark of marks) {
    if (Number(mark[2]) !== expected) continue;
    items.push(mark);
    expected += 1;
  }
  if (items.length < 2) return null;
  const intro = text.slice(0, items[0].index).trim();
  const parts = items.map((mark, index) => text.slice(mark.index + mark[0].length, index + 1 < items.length ? items[index + 1].index : text.length).trim());
  return { intro, parts };
}

function formatText(text) {
  const root = document.createDocumentFragment();
  const segments = String(text ?? '').split(/^```[^\n]*\n?/m);
  segments.forEach((segment, index) => {
    if (index % 2 === 1) {
      root.append(element('pre', {}, element('code', { text: segment.replace(/\n$/, '') })));
      return;
    }
    for (const block of segment.split(/\n\s*\n/)) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const lines = trimmed.split('\n');
      const bullet = /^\s*[-*•]\s+/;
      const numbered = /^\s*\d{1,2}[.)]\s+/;
      if (lines.every(line => bullet.test(line))) {
        root.append(element('ul', {}, ...lines.map(line => element('li', {}, inlineFormat(line.replace(bullet, ''))))));
        continue;
      }
      if (lines.length > 1 && lines.every(line => numbered.test(line))) {
        root.append(element('ol', {}, ...lines.map(line => element('li', {}, inlineFormat(line.replace(numbered, ''))))));
        continue;
      }
      const enumeration = lines.length === 1 ? inlineEnumeration(trimmed) : null;
      if (enumeration) {
        if (enumeration.intro) root.append(element('p', {}, inlineFormat(enumeration.intro)));
        root.append(element('ol', {}, ...enumeration.parts.map(part => element('li', {}, inlineFormat(part)))));
        continue;
      }
      root.append(element('p', {}, withBreaks(trimmed)));
    }
  });
  return root;
}

function renderThread() {
  const task = view.type === 'task' ? findTask(view.id) : null;
  // Una tarea que ya no existe (archivada con la papelera) deja la vista vacía, una vez cargado el estado.
  if (view.type === 'task' && !task && loaded) view = { type: 'channel' };
  $('#compose-view').hidden = view.type !== 'compose';
  $('#thread-view').hidden = view.type === 'compose';
  if (view.type === 'compose') return;
  $('#thread-head').hidden = !task;
  $('#reply-to').hidden = Boolean(task);
  if (task) {
  $('#thread-title').textContent = `${task.id} · ${task.title}`;
  const meta = [];
  {
    const info = data.agents[task.assignee] ?? {};
    meta.push(`Asignada a ${names[task.assignee]}`, statusNames[task.status] ?? task.status);
    const advice = task.recommendation;
    if (advice?.agent) meta.push(`Orquestador: ${names[advice.agent]} · ${advice.model} · esfuerzo ${advice.effort}`);
    if (task.verifiedBy) meta.push(`verificada por ${names[task.verifiedBy] ?? task.verifiedBy}`);
    if (info.state === 'sin_tokens' && task.status !== 'verificada') meta.push(`⚠ ${names[task.assignee]} está sin tokens: reasígnala`);
  }
  $('#thread-meta').textContent = meta.join(' · ');
  }
  if (task) {
    $('#reassign').value = task.assignee;
    $('#verify').hidden = task.status === 'verificada';
    $('#reopen').hidden = !['terminada', 'verificada'].includes(task.status);
    $('#popout').hidden = Boolean(solo);
    $('#thread-close').hidden = Boolean(solo);
  }
  const messages = messagesOf(view);
  const key = `${conversationKey(view)}:${messages.length}:${messages.at(-1)?.seq ?? 0}`;
  const list = $('#messages');
  if (key !== renderedKey) {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80 || !renderedKey.startsWith(`${conversationKey(view)}:`);
    list.replaceChildren(...messages.map(messageNode));
    renderedKey = key;
    if (nearBottom) {
      list.scrollTop = list.scrollHeight;
      requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    }
  }
  $('#empty').hidden = messages.length > 0;
  const last = messages.at(-1)?.seq ?? 0;
  if (last && seen[conversationKey(view)] !== last) { seen[conversationKey(view)] = last; storage.set('ventana-seen', seen); }
}

function render() {
  renderAgents();
  renderTasks();
  renderThread();
  document.title = view.type === 'task' && findTask(view.id) ? `${view.id} · CANAL DE AGENTES` : 'CANAL DE AGENTES';
  $('.titlebar').textContent = view.type === 'task' && findTask(view.id) ? `${view.id} · Canal de Agentes` : 'Canal de Agentes';
}

function open(next) {
  if (view.type !== 'compose') previous = view;
  view = next;
  renderedKey = '';
  $('#reply-error').textContent = '';
  render();
  if (next.type === 'compose') $('#task-text').focus();
  else $('#reply-text').focus();
}

function connect() {
  const status = $('#connection');
  const events = new EventSource('/api/events');
  events.addEventListener('state', event => {
    data = JSON.parse(event.data);
    loaded = true;
    status.textContent = 'En línea';
    status.dataset.state = 'live';
    render();
  });
  events.onerror = () => {
    status.textContent = 'Sin conexión';
    status.dataset.state = 'error';
  };
}

// Recomendación del orquestador mientras se escribe la tarea.
let adviceTimer;
function updateAdvice() {
  clearTimeout(adviceTimer);
  const text = `${$('#task-title-input').value}\n${$('#task-text').value}`.trim();
  if (!text) { $('#advice').replaceChildren(); return; }
  adviceTimer = setTimeout(async () => {
    try {
      const advice = await api('/api/recommend', { text });
      if (!advice.agent) { $('#advice').replaceChildren(element('strong', { text: 'Ningún agente tiene tokens disponibles.' })); return; }
      $('#advice').replaceChildren(
        element('div', {}, 'Orquestador: ', element('strong', { text: `${names[advice.agent]} · ${advice.model} · esfuerzo ${advice.effort}` }), ` (complejidad ${advice.level})`),
        element('ul', {}, advice.reasons.map(reason => element('li', { text: reason }))),
      );
    } catch (error) {
      $('#advice').textContent = error.message;
    }
  }, 350);
}

$('#tasks').addEventListener('click', event => {
  const button = event.target.closest('.task-link');
  if (button) open({ type: 'task', id: button.dataset.id });
});
// Volver desde «Nueva tarea» a lo que había antes, con la X, Cancelar o Esc.
const back = () => open(previous.type === 'task' && findTask(previous.id) ? previous : { type: 'channel' });
$('#compose-back').addEventListener('click', back);
$('#compose-cancel').addEventListener('click', back);
$('#compose').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); back(); } });
// El canal de agentes no tiene enlace: es la vista por defecto. Desde una tarea se vuelve con la X o con Esc.
$('#thread-close').addEventListener('click', () => open({ type: 'channel' }));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && view.type === 'task' && !solo && !$('#agent-dialog').open) open({ type: 'channel' });
});
// La caja de escribir crece con el texto hasta un máximo y vuelve a una línea al enviar.
const fitReply = () => { const box = $('#reply-text'); box.style.height = 'auto'; box.style.height = `${Math.min(box.scrollHeight, 200)}px`; box.closest('.reply-box').classList.toggle('tall', box.scrollHeight > 48); };
$('#reply-text').addEventListener('input', fitReply);
$('#agents').addEventListener('click', event => {
  const button = event.target.closest('.agent');
  if (button) openAgentDialog(button.dataset.agent);
});
$('#agent-dialog').addEventListener('close', async () => {
  const dialog = $('#agent-dialog');
  const name = dialog.dataset.agent;
  const action = dialog.returnValue;
  if (!name || !['save', 'clear'].includes(action)) return;
  try {
    const body = action === 'clear' ? { clear: true } : { model: $('#agent-model').value.trim(), effort: $('#agent-effort').value, outOfTokens: $('#agent-out').checked };
    await api(`/api/agents/${name}`, body);
    announce(action === 'clear' ? `${names[name]} vuelve a la detección automática` : `Modelo de ${names[name]} actualizado`);
  } catch (error) {
    $('#reply-error').textContent = error.message;
  }
});
$('#new-task').addEventListener('click', () => open({ type: 'compose' }));
$('#task-text').addEventListener('input', updateAdvice);
$('#task-title-input').addEventListener('input', updateAdvice);

$('#compose').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  $('#compose-error').textContent = '';
  try {
    const { task } = await api('/api/tasks', { title: form.title.value, text: form.text.value, assignee: form.assignee.value || undefined });
    form.reset();
    $('#advice').replaceChildren();
    data.tasks.push(task);
    announce(`Tarea ${task.id} enviada a ${names[task.assignee]}`);
    open({ type: 'task', id: task.id });
  } catch (error) {
    $('#compose-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$('#reply').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('#reply-text').value.trim();
  if (!text) return;
  const submit = event.currentTarget.querySelector('[type="submit"]');
  submit.disabled = true;
  $('#reply-error').textContent = '';
  try {
    if (view.type === 'task') await api(`/api/tasks/${view.id}/messages`, { text });
    else await api('/api/channel', { text, to: $('#reply-to').value });
    $('#reply-text').value = '';
    fitReply();
  } catch (error) {
    $('#reply-error').textContent = error.message;
  } finally {
    submit.disabled = false;
    $('#reply-text').focus();
  }
});

for (const [selector, form] of [['#reply-text', '#reply'], ['#task-text', '#compose']]) {
  $(selector).addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $(form).requestSubmit(); }
  });
}

async function changeStatus(body, message) {
  try {
    await api(`/api/tasks/${view.id}/status`, body);
    announce(message);
  } catch (error) {
    $('#reply-error').textContent = error.message;
  }
}
$('#verify').addEventListener('click', () => changeStatus({ status: 'verificada' }, `${view.id} verificada`));
$('#reopen').addEventListener('click', () => changeStatus({ status: 'en_curso' }, `${view.id} reabierta`));
$('#reassign').addEventListener('change', event => changeStatus({ assignee: event.target.value }, `${view.id} reasignada a ${names[event.target.value]}`));
$('#popout').addEventListener('click', () => window.open(`/?task=${encodeURIComponent(view.id)}`, `tarea-${view.id}`, 'popup,width=760,height=880'));
$('#clear').addEventListener('click', async () => {
  try {
    const { archived } = await api('/api/tasks/clear');
    announce(archived ? `${archived} tareas verificadas retiradas de la lista` : 'No hay tareas verificadas');
    if (view.type === 'task' && findTask(view.id)?.status === 'verificada') open({ type: 'channel' });
  } catch (error) {
    $('#reply-error').textContent = error.message;
  }
});

connect();
render();

// Instalar la ventana como aplicación: así Chrome cede la barra de título y la página la dibuja centrada.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  $('#install').hidden = false;
});
window.addEventListener('appinstalled', () => { installPrompt = null; $('#install').hidden = true; });
$('#install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  $('#install').hidden = true;
});
