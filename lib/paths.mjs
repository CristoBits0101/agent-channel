// Rutas por usuario y sistema: cada persona guarda su clave de firma y el perfil de la ventana
// en su propia carpeta de configuración, fuera del repositorio.
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
