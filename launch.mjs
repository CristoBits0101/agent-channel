#!/usr/bin/env node
// Abre la ventana del canal en Windows, macOS o Linux:
// 1. arranca el servidor local (ventana.mjs) si no está escuchando ya;
// 2. descarga una vez el logotipo de Gemini en la carpeta de datos (no se redistribuye);
// 3. abre la ventana como aplicación de Chrome, Edge, Chromium o Brave con un perfil propio,
//    o la aplicación instalada si ya se instaló; si no hay ninguno, usa el navegador por defecto.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowProfileDir } from './lib/paths.mjs';
import { dataDir } from './lib/store.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.AGENT_WINDOW_PORT || 18544);
const url = `http://127.0.0.1:${port}/`;
// Chrome deriva este identificador de la dirección de la aplicación (id del manifiesto).
const appId = 'algdbkknlnkkchepcoilcggjpdmoohgf';
const geminiLogo = 'https://www.gstatic.com/lamda/images/gemini_sparkle_4g_512_lt_f94943af3be039176192d.png';

const listening = () => new Promise(resolve => {
  const socket = connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function startServer() {
  if (await listening()) return;
  mkdirSync(dataDir, { recursive: true });
  const log = openSync(join(dataDir, 'ventana.log'), 'a');
  spawn(process.execPath, [join(directory, 'ventana.mjs')], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await listening()) return;
    await sleep(150);
  }
  throw new Error(`El servidor no arrancó; revisa ${join(dataDir, 'ventana.log')}`);
}

async function downloadGeminiLogo() {
  const file = join(dataDir, 'gemini.png');
  if (existsSync(file)) return;
  try {
    const response = await fetch(geminiLogo, { signal: AbortSignal.timeout(8000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.ok && bytes.subarray(1, 4).toString() === 'PNG') writeFileSync(file, bytes);
  } catch {}
}

function onPath(names) {
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) if (folder && existsSync(join(folder, name))) return join(folder, name);
  }
  return null;
}

function findBrowser() {
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const relative = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Chromium\\Application\\chrome.exe'];
    for (const path of relative) for (const root of roots) if (existsSync(join(root, path))) return join(root, path);
    return null;
  }
  if (process.platform === 'darwin') {
    const apps = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'];
    for (const app of apps) {
      for (const root of ['/Applications', join(process.env.HOME ?? '', 'Applications')]) {
        const binary = join(root, `${app}.app`, 'Contents', 'MacOS', app);
        if (existsSync(binary)) return binary;
      }
    }
    return null;
  }
  return onPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']);
}

function openDefaultBrowser() {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

await startServer();
await downloadGeminiLogo();
const browser = findBrowser();
if (!browser) {
  process.stdout.write(`No se encontró Chrome, Edge, Chromium ni Brave; abriendo ${url} en el navegador por defecto.\n`);
  openDefaultBrowser();
} else {
  const installed = existsSync(join(windowProfileDir, 'Default', 'Web Applications', 'Manifest Resources', appId));
  const target = installed ? `--app-id=${appId}` : `--app=${url}`;
  spawn(browser, [target, `--user-data-dir=${windowProfileDir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,860'], { detached: true, stdio: 'ignore' }).unref();
  process.stdout.write(`Ventana abierta: ${url}\n`);
}
