// HumanLayer's rpi plugin, which New task's Workflow starts with /rpi. `claude` runs the CLI with these arguments and
// answers its stdout, throwing when it fails.
export type Claude = (args: string[]) => string;

export const RPI_MARKETPLACE = { name: 'skills', source: 'humanlayer/skills' };
export const RPI_PLUGIN = 'rpi@skills';

const message = (err: unknown) => {
  const e = err as { stderr?: unknown; message?: unknown };
  return String(e?.stderr || e?.message || err).trim().split('\n').at(-1) ?? '';
};

const list = (claude: Claude, args: string[]): Record<string, unknown>[] => {
  const out: unknown = JSON.parse(claude([...args, '--json']));
  return Array.isArray(out) ? out : [];
};

// Adds the marketplace and installs the plugin for the user, each only when missing. Never throws: what happened, or
// why it did not, is the answer, so the rest of connect goes on.
export function installRpi(claude: Claude): { ok: boolean; said: string } {
  try {
    const market = list(claude, ['plugin', 'marketplace', 'list']).find((m) => m.name === RPI_MARKETPLACE.name);
    if (market && !JSON.stringify(market).includes(RPI_MARKETPLACE.source)) {
      return { ok: false, said: `rpi not installed: the marketplace named ${RPI_MARKETPLACE.name} is not ${RPI_MARKETPLACE.source}` };
    }
    if (!market) claude(['plugin', 'marketplace', 'add', '--scope', 'user', RPI_MARKETPLACE.source]);
    const plugin = list(claude, ['plugin', 'list']).find((p) => p.id === RPI_PLUGIN && p.scope === 'user');
    if (!plugin) {
      claude(['plugin', 'install', '--scope', 'user', RPI_PLUGIN]);
      return { ok: true, said: `installed the ${RPI_PLUGIN} plugin` };
    }
    if (plugin.enabled === false) return { ok: true, said: `${RPI_PLUGIN} is installed but disabled; claude plugin enable ${RPI_PLUGIN} turns it on` };
    return { ok: true, said: `${RPI_PLUGIN} was already installed` };
  } catch (err) {
    return { ok: false, said: `rpi not installed: ${message(err)}` };
  }
}
