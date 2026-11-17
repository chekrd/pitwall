import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DATA_DIR, ROOT, UPLOADS_DIR } from '../server/config.ts';

const LABEL = 'dev.pitwall';
const OLD_NAMES = ['agent-board', 'docket'];
const plistOf = (label: string) => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const PLIST = plistOf(LABEL);
const DOMAIN = `gui/${process.getuid!()}`;
const LOG = join(DATA_DIR, 'server.log');
// pnpm's real Node path is versioned and pruned on a devEngines bump; its .bin symlink is re-pointed instead.
const PNPM_NODE = join(ROOT, 'node_modules', '.bin', 'node');
const NODE = existsSync(PNPM_NODE) ? PNPM_NODE : process.execPath;

// macOS grants Automation to the process launchd started, and Node's hardened runtime has no Apple Events entitlement,
// so launchd starts this launcher, which runs Node as its child. An ad-hoc signature's TCC identity is its cdhash: the
// binary is rebuilt only when what it is built from changes, or each install would lose the Automation grant.
const LAUNCHER_DIR = join(DATA_DIR, 'launcher');
const LAUNCHER = join(LAUNCHER_DIR, 'pitwall');
const LAUNCHER_STAMP = `${LAUNCHER}.built-from`;
const LAUNCHER_SOURCE = join(ROOT, 'scripts', 'launcher', 'launcher.c');
const LAUNCHER_ENTITLEMENTS = join(ROOT, 'scripts', 'launcher', 'launcher.entitlements');
const LAUNCHER_ID = 'dev.pitwall.launcher';
const CLANG = ['/usr/bin/clang', '-O2', '-Wall', '-Werror'];

function buildLauncher() {
  const from = createHash('sha256')
    .update(readFileSync(LAUNCHER_SOURCE)).update(readFileSync(LAUNCHER_ENTITLEMENTS)).update(CLANG.join(' ')).update(LAUNCHER_ID)
    .digest('hex');
  const signed = () => {
    try {
      execFileSync('/usr/bin/codesign', ['--verify', LAUNCHER], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  if (existsSync(LAUNCHER_STAMP) && readFileSync(LAUNCHER_STAMP, 'utf8') === from && signed()) return 'unchanged';
  mkdirSync(LAUNCHER_DIR, { recursive: true });
  const next = `${LAUNCHER}.next`;
  execFileSync(CLANG[0], [...CLANG.slice(1), '-o', next, LAUNCHER_SOURCE], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', LAUNCHER_ID, '--entitlements', LAUNCHER_ENTITLEMENTS, next], { stdio: 'inherit' });
  renameSync(next, LAUNCHER);
  writeFileSync(LAUNCHER_STAMP, from);
  return 'rebuilt; macOS asks again to let it control Ghostty';
}

const launchctl = (...args: string[]) => execFileSync('/bin/launchctl', args, { stdio: 'inherit' });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${LAUNCHER}</string>
    <string>${NODE}</string>
    <string>${join(ROOT, 'server', 'main.ts')}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;

function uninstall(label = LABEL) {
  try {
    launchctl('bootout', `${DOMAIN}/${label}`);
  } catch {
    // not loaded
  }
  rmSync(plistOf(label), { force: true });
}

// The app was called Docket, then Agent Board; its stopped service leaves state behind under an old name, the latest first.
function migrate() {
  for (const name of OLD_NAMES) {
    uninstall(`dev.${name}`);
    const moves = [
      [join(homedir(), 'Library', 'Application Support', name), DATA_DIR],
      [join(homedir(), 'Library', 'Caches', name), dirname(UPLOADS_DIR)],
    ];
    for (const [from, to] of moves) if (existsSync(from) && !existsSync(to)) renameSync(from, to);
  }
}

switch (process.argv[2]) {
  case 'install': {
    uninstall();
    migrate();
    mkdirSync(DATA_DIR, { recursive: true });
    const launcher = buildLauncher();
    writeFileSync(PLIST, plist);
    launchctl('bootstrap', DOMAIN, PLIST);
    console.log(`installed ${PLIST}\nlauncher: ${LAUNCHER} (${launcher})\nnode: ${NODE}\nlog: ${LOG}`);
    break;
  }
  case 'uninstall':
    uninstall();
    console.log('uninstalled');
    break;
  case 'restart':
    launchctl('kickstart', '-k', `${DOMAIN}/${LABEL}`);
    break;
  default:
    console.error('usage: service.ts install | uninstall | restart');
    process.exit(1);
}
