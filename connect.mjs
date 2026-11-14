#!/usr/bin/env node
// Conecta Claude Code, Codex, Gemini CLI y Antigravity al canal como servidor MCP.
// Uso: node connect.mjs            → pregunta agente por agente y enseña el cambio antes de hacerlo
//      node connect.mjs --yes      → conecta todos los agentes encontrados sin preguntar
//      node connect.mjs --print    → solo imprime la configuración, sin tocar nada
//      node connect.mjs claude codex  → limita a esos agentes
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const home = homedir();
const channel = join(dirname(fileURLToPath(import.meta.url)), 'channel.mjs');
const node = process.execPath;
const flags = new Set(process.argv.slice(2).filter(value => value.startsWith('--')));
const only = process.argv.slice(2).filter(value => !value.startsWith('--'));
const printOnly = flags.has('--print');
const assumeYes = flags.has('--yes');
const args = (as, wait) => [channel, 'mcp', '--as', as, '--max-wait', String(wait)];

function which(command) {
  const lookup = process.platform === 'win32' ? spawnSync('where', [command], { encoding: 'utf8' }) : spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
  return lookup.status === 0 ? lookup.stdout.split(/\r?\n/)[0].trim() : null;
}

function backup(file) {
  if (existsSync(file)) copyFileSync(file, `${file}.bak-agent-channel`);
}

function mergeJson(file, name, server) {
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  config.mcpServers = { ...(config.mcpServers ?? {}), [name]: server };
  backup(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

const tomlString = value => JSON.stringify(value);

const targets = [
  {
    id: 'claude',
    name: 'Claude Code',
    found: () => which('claude') !== null || existsSync(join(home, '.claude')),
    describe: () => which('claude')
      ? `claude mcp add --scope user agent-channel -- "${node}" ${args('claude', 50).map(value => `"${value}"`).join(' ')}`
      : `Añade a .mcp.json de tu proyecto o a la configuración MCP de Claude:\n${JSON.stringify({ mcpServers: { 'agent-channel': { command: node, args: args('claude', 50) } } }, null, 2)}`,
    apply: () => {
      if (!which('claude')) throw new Error('no se encontró la CLI «claude»; copia la configuración impresa a mano');
      spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'agent-channel'], { stdio: 'ignore', shell: process.platform === 'win32' });
      execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'agent-channel', '--', node, ...args('claude', 50)], { stdio: 'inherit', shell: process.platform === 'win32' });
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    file: join(home, '.codex', 'config.toml'),
    found() { return which('codex') !== null || existsSync(dirname(this.file)); },
    describe() { return `${this.file}:\n[mcp_servers.agent-channel]\ncommand = ${tomlString(node)}\nargs = [${args('codex', 50).map(tomlString).join(', ')}]\ntool_timeout_sec = 120`; },
    apply() {
      const current = existsSync(this.file) ? readFileSync(this.file, 'utf8') : '';
      const block = this.describe().split('\n').slice(1).join('\n');
      const pattern = /\n?\[mcp_servers\.agent-channel\][\s\S]*?(?=\n\[|$)/;
      const next = pattern.test(current) ? current.replace(pattern, `\n${block}\n`) : `${current.replace(/\s*$/, '')}\n\n${block}\n`;
      backup(this.file);
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, next.replace(/^\n+/, ''));
    },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    file: join(home, '.gemini', 'settings.json'),
    found() { return which('gemini') !== null; },
    server: () => ({ command: node, args: args('gemini', 3600), timeout: 3_700_000 }),
    describe() { return `${this.file} → mcpServers:\n${JSON.stringify({ 'agent-channel': this.server() }, null, 2)}`; },
    apply() { mergeJson(this.file, 'agent-channel', this.server()); },
  },
  {
    id: 'antigravity',
    name: 'Antigravity (agy)',
    file: join(home, '.gemini', 'config', 'mcp_config.json'),
    found() { return which('agy') !== null || existsSync(join(home, '.gemini', 'antigravity')); },
    server: () => ({ command: node, args: args('gemini', 3600), timeoutSeconds: -1 }),
    describe() { return `${this.file} → mcpServers:\n${JSON.stringify({ 'agent-channel': this.server() }, null, 2)}`; },
    apply() { mergeJson(this.file, 'agent-channel', this.server()); },
  },
];

const selected = targets.filter(target => !only.length || only.includes(target.id));
const prompt = printOnly || assumeYes ? null : createInterface({ input: process.stdin, output: process.stdout });
process.stdout.write(`Canal: ${channel}\n`);
for (const target of selected) {
  const found = target.found();
  process.stdout.write(`\n── ${target.name} ${found ? '(encontrado)' : '(no encontrado)'}\n${target.describe()}\n`);
  if (printOnly || (!found && !only.includes(target.id))) continue;
  const answer = assumeYes ? 's' : (await prompt.question('¿Conectar? [s/N] ')).trim().toLowerCase();
  if (!['s', 'si', 'sí', 'y', 'yes'].includes(answer)) continue;
  try {
    target.apply();
    process.stdout.write(`✓ ${target.name} conectado. Reinicia el agente para que cargue el canal.\n`);
  } catch (error) {
    process.stdout.write(`✗ ${target.name}: ${error.message}\n`);
  }
}
prompt?.close();
