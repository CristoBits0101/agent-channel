#!/usr/bin/env node
// Installs the channel window as a desktop app for the current user, on Windows, macOS or Linux:
// a desktop shortcut and an entry in the system app menu, both running `node launch.mjs`.
//
//   agent-channel install      (or: node install.mjs)
//   agent-channel uninstall    (or: node install.mjs --uninstall)
//
// To stay quiet for antivirus heuristics it only writes plain files: no PowerShell, no scripts
// in hidden windows, no downloads and nothing in the sign-in startup folders. Opening the app
// starts the local server when it is not running, so no autostart is needed.
// Shortcuts point at the Node.js binary that runs this script, so moving the folder or
// changing Node means installing again.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeShortcut } from './lib/shortcut.mjs';

const name = 'Agent Channel';
const directory = dirname(fileURLToPath(import.meta.url));
const launcher = join(directory, 'launch.mjs');
const node = process.execPath;
const home = homedir();
const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
// Testing only: put every shortcut under this folder instead of the real system folders.
const sandbox = process.env.AGENT_CHANNEL_SHORTCUTS_DIR;

for (const arg of args) {
  if (arg === '--help') {
    process.stdout.write('node install.mjs [--uninstall]\n');
    process.exit(0);
  }
  if (arg !== '--uninstall') fail(`Unknown option ${arg}. Use --uninstall or --help.`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// ---------- Windows ----------

function windowsDesktop() {
  // The desktop may be redirected (for example to OneDrive): read it from the registry, read-only.
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';
  const result = spawnSync('reg.exe', ['query', key, '/v', 'Desktop'], { encoding: 'utf8', windowsHide: true });
  const match = /Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+)/.exec(result.stdout ?? '');
  const raw = match?.[1].trim();
  const expanded = raw?.replace(/%([^%]+)%/g, (whole, variable) => process.env[variable] ?? whole);
  return expanded && !expanded.includes('%') ? expanded : join(home, 'Desktop');
}

function windows() {
  const desktop = sandbox ? join(sandbox, 'desktop') : windowsDesktop();
  const programs = sandbox ? join(sandbox, 'menu') : join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const startup = join(programs, 'Startup');
  const paths = [join(desktop, `${name}.lnk`), join(programs, `${name}.lnk`)];
  // Earlier versions could add this autostart shortcut; uninstall removes it too.
  if (uninstall) return [...paths, join(startup, `${name} server.lnk`)];
  for (const path of paths) {
    mkdirSync(dirname(path), { recursive: true });
    writeShortcut(path, {
      target: node,
      arguments: `"${launcher}"`,
      workingDirectory: directory,
      icon: join(directory, 'icon.ico'),
      description: 'Open the agent channel window',
      minimized: true,
    });
  }
  return paths;
}

// ---------- macOS ----------

function macIcon(resources) {
  // sips and iconutil ship with macOS; without them the app keeps the generic icon.
  let work;
  try {
    work = mkdtempSync(join(tmpdir(), 'agent-channel-'));
    const set = join(work, 'AppIcon.iconset');
    mkdirSync(set);
    const resize = (size, file) => spawnSync('sips', ['-z', String(size), String(size), join(directory, 'icon-512.png'), '--out', join(set, file)]);
    for (const size of [16, 32, 128, 256, 512]) {
      resize(size, `icon_${size}x${size}.png`);
      resize(size * 2, `icon_${size}x${size}@2x.png`);
    }
    spawnSync('iconutil', ['-c', 'icns', set, '-o', join(resources, 'AppIcon.icns')]);
  } catch {}
  if (work) rmSync(work, { recursive: true, force: true });
}

function mac() {
  const apps = sandbox ? join(sandbox, 'Applications') : join(home, 'Applications');
  const bundle = join(apps, `${name}.app`);
  // Earlier versions could add this sign-in agent; uninstall removes it too.
  const legacyAgent = join(sandbox ?? join(home, 'Library'), 'LaunchAgents', 'com.agent-channel.server.plist');
  if (uninstall) return [bundle, legacyAgent];

  const contents = join(bundle, 'Contents');
  const resources = join(contents, 'Resources');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(resources, { recursive: true });
  const executable = join(contents, 'MacOS', 'agent-channel');
  writeFileSync(executable, `#!/bin/sh\nexec "${node}" "${launcher}"\n`);
  chmodSync(executable, 0o755);
  writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleDisplayName</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>com.agent-channel.launcher</string>
  <key>CFBundleExecutable</key><string>agent-channel</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`);
  macIcon(resources);
  return [bundle];
}

// ---------- Linux ----------

function linuxDesktopDir() {
  if (sandbox) return join(sandbox, 'Desktop');
  const result = spawnSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' });
  const folder = result.status === 0 ? result.stdout.trim() : '';
  return folder && folder !== home ? folder : join(home, 'Desktop');
}

function linux() {
  const data = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  const menu = sandbox ? join(sandbox, 'applications', 'agent-channel.desktop') : join(data, 'applications', 'agent-channel.desktop');
  const desktopDir = linuxDesktopDir();
  const desktop = join(desktopDir, 'agent-channel.desktop');
  // Earlier versions could add this autostart entry; uninstall removes it too.
  const legacyStartup = sandbox ? join(sandbox, 'autostart', 'agent-channel-server.desktop') : join(config, 'autostart', 'agent-channel-server.desktop');
  if (uninstall) return [menu, desktop, legacyStartup];

  const quote = value => `"${value.replace(/(["`$\\])/g, '\\$1')}"`;
  const entry = `[Desktop Entry]
Type=Application
Name=${name}
Comment=Open the agent channel window
Exec=${quote(node)} ${quote(launcher)}
Path=${directory}
Icon=${join(directory, 'icon-512.png')}
Terminal=false
Categories=Development;
`;
  const created = [];
  for (const path of [menu, ...(existsSync(desktopDir) || sandbox ? [desktop] : [])]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry);
    chmodSync(path, 0o755);
    created.push(path);
  }
  // GNOME only launches desktop-folder entries marked as trusted.
  if (created.includes(desktop)) spawnSync('gio', ['set', desktop, 'metadata::trusted', 'true']);
  return created;
}

// ---------- Main ----------

if (!existsSync(launcher)) fail(`launch.mjs not found next to install.mjs (${directory}).`);
const handler = process.platform === 'win32' ? windows : process.platform === 'darwin' ? mac : linux;

try {
  const paths = handler();
  if (uninstall) {
    const removed = paths.filter(path => existsSync(path));
    for (const path of removed) rmSync(path, { recursive: true, force: true });
    process.stdout.write(removed.length ? `Removed:\n${removed.map(path => `  ${path}`).join('\n')}\n` : 'Nothing to remove.\n');
  } else {
    process.stdout.write(`Installed ${name}:\n${paths.map(path => `  ${path}`).join('\n')}\n`);
  }
} catch (error) {
  fail(`Install failed: ${error.message}`);
}
