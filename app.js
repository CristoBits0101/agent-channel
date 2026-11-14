'use strict';

const token = document.querySelector('meta[name="window-token"]').content;
const $ = selector => document.querySelector(selector);
const names = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', owner: 'Owner', all: 'All' };
const stateNames = { active: 'Active', idle: 'Idle', out_of_tokens: 'Out of tokens', unknown: 'No data' };
const statusNames = { assigned: 'Assigned', in_progress: 'In progress', done: 'Done · to verify', verified: 'Verified', blocked: 'Blocked' };
// Local time of each user's machine.
const zone = undefined;
const dayFormat = new Intl.DateTimeFormat(undefined, { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: '2-digit', minute: '2-digit' });
const shortDayFormat = new Intl.DateTimeFormat(undefined, { timeZone: zone, day: '2-digit', month: '2-digit' });
const fullFormat = new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: 'full', timeStyle: 'medium' });

const params = new URLSearchParams(location.search);
const solo = /^T-\d{3,}$/.test(params.get('task') ?? '') ? params.get('task') : null;
if (solo) document.body.dataset.solo = '';

let data = { agents: {}, tasks: [], messages: [] };
// The main view is the agent channel; each task opens its own chat.
let view = solo ? { type: 'task', id: solo } : { type: 'channel' };
let previous = view;
let loaded = false;
let renderedKey = '';

const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};
const seen = storage.get('window-seen') ?? {};
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
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Window-Token': token }, body: JSON.stringify(body ?? {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `Error ${response.status}`);
  return result;
}

const announce = text => { $('#announce').textContent = ''; requestAnimationFrame(() => { $('#announce').textContent = text; }); };
const messagesOf = current => data.messages.filter(message => current.type === 'task' ? message.task === current.id : !message.task);
const findTask = id => data.tasks.find(task => task.id === id);

// Agents show their company's official logo (logos.js); the owner shows initials.
function logo(who) {
  // The Gemini logo is not redistributed: the launcher downloads it from Google into the data folder.
  if (who === 'gemini') {
    const image = element('img', { src: '/gemini.png', alt: '', width: '18', height: '18' });
    image.addEventListener('error', () => image.replaceWith(document.createTextNode('Ge')), { once: true });
    return image;
  }
  const path = window.agentLogos?.[who];
  if (!path) return document.createTextNode(who === 'owner' ? 'You' : String(who).slice(0, 2));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('focusable', 'false');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}
const avatar = (who, withState = false) => element('span', { class: 'avatar', 'data-who': who, 'aria-hidden': 'true' }, logo(who), withState ? element('span', { class: 'state' }) : null);

// Only what changed is repainted, so focus and clicks survive while live state arrives.
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
    const state = stateNames[info.state] ?? 'No data';
    const model = info.state === 'out_of_tokens' ? `Out of tokens · ${info.label ?? ''}` : info.label ? `${info.label}${info.effort ? ` · ${info.effort}` : ''}` : 'Model not detected';
    const used = typeof info.usedPercent === 'number' ? Math.max(0, Math.min(100, Math.round(info.usedPercent))) : null;
    const quotaNote = info.usageDetail ? `usage ${info.usageDetail}` : used === null ? (name === "gemini" ? "Antigravity does not expose its quota" : "no quota data") : null;
    const details = [state, quotaNote, info.permission?.detail, info.source, info.declared ? `set ${formatTime(info.declared.at).short}` : null, info.resetsAt ? `quota resets ${formatTime(info.resetsAt).short}` : null, info.limitText].filter(Boolean).join(' · ');
    const button = element('button', { type: 'button', class: 'agent', 'data-state': info.state ?? 'unknown', 'data-agent': name, title: details, 'aria-label': `${names[name]}: ${model}. ${state}${used !== null ? `. Quota used ${used} %` : ''}. ${info.permission?.label ?? 'Permissions unknown'}. Change model` },
      avatar(name, true),
      element('span', { class: 'agent-info' },
        element('span', { class: 'agent-line' },
          element('span', { class: 'agent-name', text: names[name] }),
          element('span', { class: 'agent-permission', title: info.permission?.detail ?? 'Permissions not detected', text: info.permission?.label ?? 'No data' })),
        element('span', { class: 'agent-line' },
          element('span', { class: 'agent-model', text: model }),
          usage(used, name))));
    return element('li', {}, button);
  }));
}

// Quota usage: a thin bar and the percentage used; without data it says so instead of inventing a number.
function usage(used, name) {
  if (used === null) return element('span', { class: 'agent-usage', 'data-level': 'none', title: name === 'gemini' ? 'Antigravity does not expose its quota' : 'No quota data', text: 'No data' });
  const bar = element('span', { class: 'usage-bar', 'aria-hidden': 'true' }, element('span'));
  bar.firstChild.style.width = `${used}%`;
  return element('span', { class: 'agent-usage', 'data-level': used >= 85 ? 'high' : 'normal', title: `${used} % of the quota used` }, bar, `${used} %`);
}

function openAgentDialog(name) {
  const info = data.agents[name] ?? {};
  const dialog = $('#agent-dialog');
  dialog.dataset.agent = name;
  $('#agent-dialog-title').textContent = `${names[name]} Model`;
  $('#agent-source').textContent = info.declared ? `Set by hand ${formatTime(info.declared.at).short}. Detection: ${info.source ?? 'no data'}.` : `Detected from: ${info.source ?? 'no data'}.`;
  $('#agent-model').value = info.model ?? '';
  $('#agent-effort').value = ['low', 'medium', 'high', 'xhigh', 'ultra'].includes(info.effort) ? info.effort : '';
  $('#agent-out').checked = info.state === 'out_of_tokens';
  dialog.showModal();
}

function unreadCount(key, messages) {
  const last = seen[key] ?? 0;
  return messages.filter(message => message.seq > last && message.from !== 'owner').length;
}

function renderTasks() {
  const list = $('#tasks');
  if (!changed('tasks', [view, data.tasks.map(task => [task.id, task.title, task.status, task.assignee]), data.messages.at(-1)?.seq, seen])) return;
  const ordered = [...data.tasks].sort((a, b) => (a.status === 'verified') - (b.status === 'verified') || a.id.localeCompare(b.id));
  list.replaceChildren(...ordered.map(task => {
    const unread = view.type === 'task' && view.id === task.id ? 0 : unreadCount(task.id, messagesOf({ type: 'task', id: task.id }));
    const button = element('button', { type: 'button', class: 'task-link', 'data-status': task.status, 'data-id': task.id, 'aria-current': view.type === 'task' && view.id === task.id ? 'true' : 'false' },
      element('span', { class: 'task-mark', 'aria-hidden': 'true', text: task.status === 'verified' ? '✓' : '' }),
      element('span', { class: 'task-body' },
        element('span', { class: 'task-title', text: task.title }),
        element('span', { class: 'task-meta' },
          element('span', { text: `${task.id} · ${names[task.assignee]} · ${statusNames[task.status] ?? task.status}` }),
          unread ? element('span', { class: 'unread', text: String(unread), 'aria-label': `${unread} unread messages` }) : null)));
    return element('li', {}, button);
  }));
  $('#no-tasks').hidden = data.tasks.length > 0;
  $('#clear').disabled = !data.tasks.some(task => task.status === 'verified');
  const open = data.tasks.filter(task => task.status !== 'verified').length;
  $('#task-count').textContent = data.tasks.length ? String(data.tasks.length) : '';
  $('#task-count').setAttribute('aria-label', `${data.tasks.length} tasks, ${open} open`);
}

function messageNode(message) {
  const time = formatTime(message.at);
  const sender = element('span', { class: 'sender' }, names[message.from] ?? message.from);
  if (message.model) sender.append(' ', element('span', { class: 'version', text: `· ${message.model}` }));
  if (message.from === 'owner') sender.append(' ', element('span', { class: 'version', text: message.signed ? '· from the window' : '· unsigned (console)' }));
  if (message.to && message.to !== 'all') sender.append(' ', element('span', { class: 'to', text: `→ ${names[message.to] ?? message.to}` }));
  return element('li', { class: 'message', 'data-from': message.from, 'data-seq': String(message.seq) },
    avatar(message.from),
    element('div', { class: 'message-main' },
      element('div', { class: 'message-head' }, sender, element('time', { class: 'time', datetime: message.at, title: time.full, text: time.short })),
      element('div', { class: 'message-text' }, formatText(message.text))));
}

// Message text formatting, built from nodes (never innerHTML): ``` code blocks,
// lists with "- ", "1." or "1)", inline enumerations "1) … 2) …", paragraphs, `code`, **bold** and @mentions.
function inlineFormat(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(^|[\s(])(@(?:all|claude|codex|gemini|owner))\b/gi;
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

// "Intro: 1) one 2) two" → intro and list, only when the numbers run in order from 1.
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
  // A task that no longer exists (archived with the trash button) falls back to the channel once state has loaded.
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
    meta.push(`Assigned to ${names[task.assignee]}`, statusNames[task.status] ?? task.status);
    const advice = task.recommendation;
    if (advice?.agent) meta.push(`Orchestrator: ${names[advice.agent]} · ${advice.model} · effort ${advice.effort}`);
    if (task.verifiedBy) meta.push(`verified by ${names[task.verifiedBy] ?? task.verifiedBy}`);
    if (info.state === 'out_of_tokens' && task.status !== 'verified') meta.push(`⚠ ${names[task.assignee]} is out of tokens: reassign it`);
  }
  $('#thread-meta').textContent = meta.join(' · ');
  }
  if (task) {
    $('#reassign').value = task.assignee;
    $('#verify').hidden = task.status === 'verified';
    $('#reopen').hidden = !['done', 'verified'].includes(task.status);
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
  if (last && seen[conversationKey(view)] !== last) { seen[conversationKey(view)] = last; storage.set('window-seen', seen); }
}

function render() {
  renderAgents();
  renderTasks();
  renderThread();
  document.title = view.type === 'task' && findTask(view.id) ? `${view.id} · AGENT CHANNEL` : 'AGENT CHANNEL';
  $('.titlebar').textContent = view.type === 'task' && findTask(view.id) ? `${view.id} · Agent Channel` : 'Agent Channel';
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
    status.textContent = 'Online';
    status.dataset.state = 'live';
    render();
  });
  events.onerror = () => {
    status.textContent = 'Offline';
    status.dataset.state = 'error';
  };
}

// Orchestrator recommendation while the task is being written.
let adviceTimer;
function updateAdvice() {
  clearTimeout(adviceTimer);
  const text = `${$('#task-title-input').value}\n${$('#task-text').value}`.trim();
  if (!text) { $('#advice').replaceChildren(); return; }
  adviceTimer = setTimeout(async () => {
    try {
      const advice = await api('/api/recommend', { text });
      if (!advice.agent) { $('#advice').replaceChildren(element('strong', { text: 'No agent has tokens available.' })); return; }
      $('#advice').replaceChildren(
        element('div', {}, 'Orchestrator: ', element('strong', { text: `${names[advice.agent]} · ${advice.model} · effort ${advice.effort}` }), ` (complexity ${advice.level})`),
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
// Go back from "New Task" to the previous view with X, Cancel or Esc.
const back = () => open(previous.type === 'task' && findTask(previous.id) ? previous : { type: 'channel' });
$('#compose-back').addEventListener('click', back);
$('#compose-cancel').addEventListener('click', back);
$('#compose').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); back(); } });
// The agent channel has no link: it is the default view. From a task, X or Esc goes back.
$('#thread-close').addEventListener('click', () => open({ type: 'channel' }));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && view.type === 'task' && !solo && !$('#agent-dialog').open) open({ type: 'channel' });
});
// The message box grows with the text up to a maximum and returns to one line on send.
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
    announce(action === 'clear' ? `${names[name]} is back on automatic detection` : `${names[name]} model updated`);
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
    if (!findTask(task.id)) data.tasks.push(task);
    announce(`Task ${task.id} sent to ${names[task.assignee]}`);
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
$('#verify').addEventListener('click', () => changeStatus({ status: 'verified' }, `${view.id} verified`));
$('#reopen').addEventListener('click', () => changeStatus({ status: 'in_progress' }, `${view.id} reopened`));
$('#reassign').addEventListener('change', event => changeStatus({ assignee: event.target.value }, `${view.id} reassigned to ${names[event.target.value]}`));
$('#popout').addEventListener('click', () => window.open(`/?task=${encodeURIComponent(view.id)}`, `task-${view.id}`, 'popup,width=760,height=880'));
$('#clear').addEventListener('click', async () => {
  try {
    const { archived } = await api('/api/tasks/clear');
    announce(archived ? `${archived} verified tasks removed from the list` : 'No verified tasks');
    if (view.type === 'task' && findTask(view.id)?.status === 'verified') open({ type: 'channel' });
  } catch (error) {
    $('#reply-error').textContent = error.message;
  }
});

connect();
render();

// Install the window as an app: Chrome then hands over the title bar and the page draws it centered.
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
