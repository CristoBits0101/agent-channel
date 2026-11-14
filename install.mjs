#!/usr/bin/env node
// Installs the channel window as a desktop app for the current user, on Windows, macOS or Linux:
// a desktop shortcut and an entry in the system app menu, both pointing at `node launch.mjs`.
//
//   node install.mjs               install the shortcuts
//   node install.mjs --autostart   also start the local server when you sign in
//   node install.mjs --uninstall   remove everything this script created
//
// Nothing needs administrator rights and nothing is downloaded. Shortcuts point straight at the
// Node.js binary that runs this script, so moving the clone or changing Node means installing again.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const name = 'Agent Channel';
const directory = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '');
const launcher = join(directory, 'launch.mjs');
const node = process.execPath;
const home = homedir();
const args = new Set(process.argv.slice(2));
const uninstall = args.has('--uninstall');
const autostart = args.has('--autostart');
// Testing only: put every shortcut under this folder instead of the real system folders.
const sandbox = process.env.AGENT_CHANNEL_SHORTCUTS_DIR;

for (const arg of args) {
  if (!['--uninstall', '--autostart', '--help'].includes(arg)) fail(`Unknown option ${arg}. Use --autostart, --uninstall or --help.`);
}
if (args.has('--help')) {
  process.stdout.write('node install.mjs [--autostart] | --uninstall\n');
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, commandArgs, input) {
  const result = spawnSync(command, commandArgs, { input, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || `${command} failed`).trim());
  return result.stdout.trim();
}

function remove(path, report) {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
  report.push(path);
}

// ---------- Windows ----------

function windowsFolders() {
  if (sandbox) return { desktop: join(sandbox, 'desktop'), menu: join(sandbox, 'menu'), startup: join(sandbox, 'startup') };
  // Ask Windows: the desktop may be redirected, for example to OneDrive.
  const output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Programs'); [Environment]::GetFolderPath('Startup')"]);
  const [desktop, menu, startup] = output.split(/\r?\n/);
  return { desktop, menu, startup };
}

function windowsShortcuts(shortcuts) {
  // WScript.Shell writes the .lnk files. The values travel in environment variables, never inside the script text.
  const script = `
$shell = New-Object -ComObject WScript.Shell
$items = $env:AC_SHORTCUTS | ConvertFrom-Json
foreach ($item in $items) {
  New-Item -ItemType Directory -Force -Path (Split-Path $item.path) | Out-Null
  $link = $shell.CreateShortcut($item.path)
  $link.TargetPath = $env:AC_NODE
  $link.Arguments = $item.arguments
  $link.WorkingDirectory = $env:AC_DIR
  $link.IconLocation = $env:AC_ICON + ',0'
  $link.Description = $item.description
  $link.WindowStyle = 7
  $link.Save()
}`;
  // Passed as an argument: with `-Command -` PowerShell reads stdin line by line and skips multi-line blocks.
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, AC_SHORTCUTS: JSON.stringify(shortcuts), AC_NODE: node, AC_DIR: directory, AC_ICON: join(directory, 'icon.ico') },
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Could not create the shortcuts');
  const missing = shortcuts.filter(shortcut => !existsSync(shortcut.path));
  if (missing.length) throw new Error(`Windows did not create ${missing.map(shortcut => shortcut.path).join(', ')}. ${result.stderr.trim()}`);
}

function windows() {
  const folders = windowsFolders();
  const paths = {
    desktop: join(folders.desktop, `${name}.lnk`),
    menu: join(folders.menu, `${name}.lnk`),
    startup: join(folders.startup, `${name} server.lnk`),
  };
  if (uninstall) return Object.values(paths);
  const open = { arguments: `"${launcher}"`, description: 'Open the agent channel window' };
  const shortcuts = [{ path: paths.desktop, ...open }, { path: paths.menu, ...open }];
  if (autostart) shortcuts.push({ path: paths.startup, arguments: `"${launcher}" --server-only`, description: 'Start the agent channel server' });
  windowsShortcuts(shortcuts);
  return shortcuts.map(shortcut => shortcut.path);
}

// ---------- macOS ----------

function macIcon(resources) {
  // sips and iconutil ship with macOS; without them the app keeps the generic icon.
  try {
    const set = join(mkdtempSync(join(tmpdir(), 'agent-channel-')), 'AppIcon.iconset');
    mkdirSync(set);
    for (const size of [16, 32, 128, 256, 512]) {
      run('sips', ['-z', String(size), String(size), join(directory, 'icon-512.png'), '--out', join(set, `icon_${size}x${size}.png`)]);
      run('sips', ['-z', String(size * 2), String(size * 2), join(directory, 'icon-512.png'), '--out', join(set, `icon_${size}x${size}@2x.png`)]);
    }
    run('iconutil', ['-c', 'icns', set, '-o', join(resources, 'AppIcon.icns')]);
    rmSync(join(set, '..'), { recursive: true, force: true });
  } catch {}
}

function mac() {
  const apps = sandbox ? join(sandbox, 'Applications') : join(home, 'Applications');
  const agents = sandbox ? join(sandbox, 'LaunchAgents') : join(home, 'Library', 'LaunchAgents');
  const bundle = join(apps, `${name}.app`);
  const agent = join(agents, 'com.agent-channel.server.plist');
  if (uninstall) return [bundle, agent];

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
  const created = [bundle];
  if (autostart) {
    mkdirSync(agents, { recursive: true });
    writeFileSync(agent, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agent-channel.server</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${launcher}</string><string>--server-only</string></array>
  <key>WorkingDirectory</key><string>${directory}</string>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`);
    created.push(agent);
  }
  return created;
}

// ---------- Linux ----------

function linuxDesktopDir() {
  if (sandbox) return join(sandbox, 'Desktop');
  try {
    const folder = run('xdg-user-dir', ['DESKTOP']);
    if (folder && folder !== home) return folder;
  } catch {}
  return join(home, 'Desktop');
}

function linux() {
  const data = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  const menu = sandbox ? join(sandbox, 'applications', 'agent-channel.desktop') : join(data, 'applications', 'agent-channel.desktop');
  const desktopDir = linuxDesktopDir();
  const desktop = join(desktopDir, 'agent-channel.desktop');
  const startup = sandbox ? join(sandbox, 'autostart', 'agent-channel-server.desktop') : join(config, 'autostart', 'agent-channel-server.desktop');
  if (uninstall) return [menu, desktop, startup];

  const quote = value => `"${value.replace(/(["`$\\])/g, '\\$1')}"`;
  const entry = (title, extra, comment) => `[Desktop Entry]
Type=Application
Name=${title}
Comment=${comment}
Exec=${quote(node)} ${quote(launcher)}${extra}
Path=${directory}
Icon=${join(directory, 'icon-512.png')}
Terminal=false
Categories=Development;
`;
  const created = [];
  const write = (path, text) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    chmodSync(path, 0o755);
    created.push(path);
  };
  write(menu, entry(name, '', 'Open the agent channel window'));
  if (existsSync(desktopDir) || sandbox) {
    write(desktop, entry(name, '', 'Open the agent channel window'));
    // GNOME only launches desktop files marked as trusted.
    try { run('gio', ['set', desktop, 'metadata::trusted', 'true']); } catch {}
  }
  if (autostart) write(startup, entry(`${name} server`, ' --server-only', 'Start the agent channel server'));
  return created;
}

// ---------- Main ----------

if (!existsSync(launcher)) fail(`launch.mjs not found next to install.mjs (${directory}).`);
const platform = process.platform;
const handler = platform === 'win32' ? windows : platform === 'darwin' ? mac : linux;

try {
  const paths = handler();
  if (uninstall) {
    const removed = [];
    for (const path of paths) remove(path, removed);
    process.stdout.write(removed.length ? `Removed:\n${removed.map(path => `  ${path}`).join('\n')}\n` : 'Nothing to remove.\n');
  } else {
    process.stdout.write(`Installed ${name}:\n${paths.map(path => `  ${path}`).join('\n')}\n`);
    if (!autostart) process.stdout.write('Add --autostart to start the local server when you sign in.\n');
  }
} catch (error) {
  fail(`Install failed: ${error.message}`);
}
