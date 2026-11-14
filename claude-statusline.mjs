// Claude Code status line. Claude Code passes a JSON on stdin that, on Pro, Max and Ultra plans,
// includes rate_limits.five_hour and rate_limits.seven_day (used_percentage, resets_at).
// It saves that usage in data/claude-usage.json so the channel window shows the percentage,
// and prints a short line with the model and the usage.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(process.env.AGENT_CHANNEL_DATA ?? join(dirname(fileURLToPath(import.meta.url)), 'data'), 'claude-usage.json');
let input = '';
for await (const chunk of process.stdin) input += chunk;
let data = {};
try { data = JSON.parse(input); } catch {}

const window = value => typeof value?.used_percentage === 'number'
  ? { usedPercent: value.used_percentage, resetsAt: typeof value.resets_at === 'number' ? new Date(value.resets_at * 1000).toISOString() : null }
  : null;
const fiveHour = window(data.rate_limits?.five_hour);
const sevenDay = window(data.rate_limits?.seven_day);

if (fiveHour || sevenDay) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ at: new Date().toISOString(), model: data.model?.id ?? null, fiveHour, sevenDay }, null, 2)}\n`);
    renameSync(temporary, file);
  } catch {}
}

const parts = [data.model?.display_name ?? data.model?.id ?? 'Claude'];
if (fiveHour) parts.push(`5 h ${Math.round(fiveHour.usedPercent)} %`);
if (sevenDay) parts.push(`7 d ${Math.round(sevenDay.usedPercent)} %`);
process.stdout.write(parts.join(' · '));
