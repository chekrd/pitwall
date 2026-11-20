import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The skills that work through Pitwall, kept as user skills so that every session has them.
export const SKILL_NAMES = ['grill-me', 'architecture'];
// Marks a skill folder as Pitwall's, so that disconnecting removes only what connecting put there.
const OURS = '.pitwall';
// Stands for Pitwall's folder in a skill's text, for the commands it runs from there.
const PITWALL = '{{PITWALL}}';

export function installSkills(connect: boolean, { from, to, pitwall, warn = console.warn }: { from: string; to: string; pitwall: string; warn?: (message: string) => void }) {
  for (const name of SKILL_NAMES) {
    const dir = join(to, name);
    if (existsSync(dir) && !existsSync(join(dir, OURS))) {
      warn(`${dir} is a skill of your own, left as it is; remove it to get Pitwall's ${name}`);
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
    if (!connect) continue;
    cpSync(join(from, name), dir, { recursive: true });
    const skill = join(dir, 'SKILL.md');
    writeFileSync(skill, readFileSync(skill, 'utf8').replaceAll(PITWALL, pitwall));
    writeFileSync(join(dir, OURS), '');
  }
}
