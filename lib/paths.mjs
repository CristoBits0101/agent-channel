// Per-user, per-system paths: each person keeps their signing key and the window profile
// in their own config folder, outside the repository.
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const home = homedir();

export function userConfigDir(name) {
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), name);
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', name);
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), name);
}

export const ownerKeyFile = process.env.AGENT_OWNER_KEY ?? join(userConfigDir('agent-channel'), 'owner.key');
export const windowProfileDir = process.env.AGENT_WINDOW_PROFILE ?? userConfigDir('agent-channel-window');
