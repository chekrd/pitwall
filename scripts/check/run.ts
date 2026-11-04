import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LIVE_PORT, refuseLive } from '../isolate.ts';
import { holds, launch, lookName, sleep, within, type Browser, type Look, type Page } from './cdp.ts';
import { checks } from './checks/index.ts';
import { NEW_TASK_MORE, type Check } from './helpers.ts';
import { startMock, type Mock } from './mock.ts';

// pnpm e2e [--only <pattern>] [--matrix] [--workers <n>] [--port <mock port>] [--shots <dir>] [--dist <dir>] [--stale]
// Runs the checks in checks/ against the mock in a headless Brave of its own. While changing something, run the
// checks it touches with --only and the whole suite once before committing. Each worker has a mock on a free port
// and a browser of its own (--workers, default half the cores, at most 6); with --port, one worker uses that mock.
// Each check runs once, in dark: a check switches the system to light and back for its colour assertions (themes())
// and its screenshots, so both schemes are covered; --matrix instead runs every check in each scheme, at 1100×900
// and with reduced motion too. --shots saves each check's screenshots under <dir>/<look>/; failures always land in
// .e2e/. A check fails on an error in the page and on a request to any host but 127.0.0.1, where the mocks are.
// A build older than its sources is refused, unless --stale.

const ROOT = resolve(import.meta.dirname, '../..');
const FAILURES = join(ROOT, '.e2e');
const CHECK_TIMEOUT_MS = 60_000;
const FAST_CLOCK = 4;

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    matrix: { type: 'boolean', default: false },
    port: { type: 'string' },
    shots: { type: 'string' },
    workers: { type: 'string' },
    dist: { type: 'string', default: join(ROOT, 'web', 'dist') },
    stale: { type: 'boolean', default: false },
  },
});
if (args.port) refuseLive(Number(args.port));
const ownDist = resolve(args.dist) === join(ROOT, 'web', 'dist');
const build = ownDist ? 'pnpm build' : `pnpm exec vite build --outDir ${args.dist} --emptyOutDir`;
const entry = join(resolve(args.dist), 'index.html');
if (!existsSync(entry)) {
  console.error(`no UI build in ${args.dist}; run ${build} first`);
  process.exit(2);
}
const newer = args.stale ? undefined : changedSince(statSync(entry).mtimeMs);
if (newer) {
  console.error(`the UI build in ${args.dist} is older than ${relative(ROOT, newer)}; run ${build} first (or pass --stale to check it as it is)`);
  process.exit(2);
}
process.env.PITWALL_E2E_DIST = resolve(args.dist);
// The mock's times are set from now, such as a limit that resets in 133 min, and a time on another day shows its
// weekday too, which widens the top bar. A zone where the run starts at 10:00 keeps them all on one day; the mock
// and the browser take it from this process.
const offset = ((10 - new Date().getUTCHours() + 36) % 24) - 12;
process.env.TZ = offset ? `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}` : 'Etc/GMT';

const schemes = ['dark', 'light'] as const;
const motions = args.matrix ? (['no-preference', 'reduce'] as const) : (['no-preference'] as const);
const wide = args.matrix ? [[1440, 900], [1100, 900]] : [[1440, 900]];
const narrow = [[390, 844]];
const looks = (sizes: number[][], inSchemes: readonly Look['scheme'][] = schemes) =>
  sizes.flatMap(([width, height]) => inSchemes.flatMap((scheme) => motions.map((motion): Look => ({ scheme, width, height, motion }))));

const pattern = args.only ? new RegExp(args.only, 'i') : null;
const chosen = checks.filter((c) => !pattern || pattern.test(c.name));
// A check that asks for a motion runs with it, and once per look where the run has that motion too.
const looksOf = (c: Check, look: Look): Look[] => {
  if (!c.motion || c.motion === look.motion) return [look];
  return (motions as readonly string[]).includes(c.motion) ? [] : [{ ...look, motion: c.motion }];
};
const runsIn = (all: Look[], narrowOnes: boolean) =>
  all.flatMap((look) => chosen.filter((c) => !!c.narrow === narrowOnes).flatMap((c) => looksOf(c, look).map((l): [Check, Look] => [c, l])));
const perScheme: readonly Look['scheme'][] = args.matrix ? schemes : ['dark'];
const runs: [Check, Look][] = [...runsIn(looks(wide, perScheme), false), ...runsIn(looks(narrow, perScheme), true)];
const workers = args.port ? 1 : Math.max(1, Math.min(runs.length, Number(args.workers ?? Math.min(6, Math.floor(availableParallelism() / 2)))));
if (!runs.length) {
  console.error(`no check matches ${args.only}`);
  process.exit(2);
}

// The first source the build is made of that changed after `since`: web/src, web/public, index.html, the Vite
// config, and the server modules web/src imports for more than their types.
function changedSince(since: number) {
  const web = join(ROOT, 'web');
  const files = [join(web, 'index.html'), join(ROOT, 'vite.config.ts')];
  for (const dir of ['src', 'public']) {
    for (const f of readdirSync(join(web, dir), { recursive: true, withFileTypes: true })) if (f.isFile()) files.push(join(f.parentPath, f.name));
  }
  for (const f of files.filter((f) => /\.tsx?$/.test(f) && f.startsWith(join(web, 'src')))) {
    for (const [, path] of readFileSync(f, 'utf8').matchAll(/^import (?!type )[^;]*? from '((?:\.\.\/)+server\/[^']+)'/gm)) files.push(resolve(dirname(f), path));
  }
  return files.find((f) => (statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0) > since);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const mocks = new Set<Mock>();
const browsers = new Set<Browser>();
const stop = async () => {
  await Promise.all([...browsers].map((b) => b.close().catch(() => {})));
  await Promise.all([...mocks].map((m) => m.stop().catch(() => {})));
};
// Leaving kills the browsers and mocks still running (cdp.ts and mock.ts see to that on exit).
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
process.on('uncaughtException', (err) => {
  console.error(err);
  process.exit(1);
});

const other = (scheme: Look['scheme']): Look['scheme'] => (scheme === 'dark' ? 'light' : 'dark');

// Setup and teardown count as the check's own: a failure there fails the check, not the run. A check that times
// out is still running; it has its page closed under it and is waited on for a while, and the worker then takes a
// fresh mock (timedOut), so nothing it does later reaches the next check.
async function runOne(mock: Mock, browser: Browser, check: Check, look: Look) {
  let page: Page | undefined;
  let running: Promise<void> | undefined;
  let timedOut = false;
  try {
    await mock.reset(check.scenario ?? 'queue');
    const p = (page = await browser.newPage(look));
    const speed = check.clock === 'fast' ? FAST_CLOCK : 1;
    if (speed !== 1) await p.fastClock(speed);
    if (check.newTask !== 'default') await p.initScript(NEW_TASK_MORE);
    const settled = () => p.until('the transitions to end', () => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState === 'finished'));
    let current = look.scheme;
    // Inside themes() a screenshot is of the scheme being checked only.
    let inside = false;
    const themes = async (fn: (scheme: Look['scheme']) => Promise<void>) => {
      inside = true;
      try {
        await fn(look.scheme);
        if (args.matrix) return;
        current = other(look.scheme);
        await p.scheme(current);
        try {
          await settled();
          await fn(current);
        } finally {
          current = look.scheme;
          await p.scheme(current);
        }
        await settled();
      } finally {
        inside = false;
      }
    };
    const save = async (scheme: Look['scheme'], name: string) => {
      await settled();
      await p.shot(join(resolve(args.shots!, lookName({ ...look, scheme })), `${name}.png`));
    };
    const shot = async (name: string) => {
      if (!args.shots) return;
      if (inside) return save(current, name);
      await themes((scheme) => save(scheme, name));
    };
    // What the page times shrinks; the half second the check allows for delivery and rendering does not.
    const onPageClock = (ms: number) => (speed === 1 ? ms : ms / speed + 500);
    const wait = async (ms: number) => {
      await sleep(onPageClock(ms));
    };
    running = check.run({ page: p, mock, look, shot, themes, wait, holds: (what, ms, fn) => holds(what, onPageClock(ms), fn) });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      running,
      new Promise((_, fail) => (timer = setTimeout(() => {
        timedOut = true;
        fail(new Error(`no result after ${CHECK_TIMEOUT_MS / 1000} s`));
      }, CHECK_TIMEOUT_MS))),
    ]).finally(() => clearTimeout(timer));
    await sleep(100);
    const unexpected = p.errors.filter((e) => !check.expectedErrors?.some((re) => re.test(e)));
    if (unexpected.length) throw new Error(`errors in the page:\n${unexpected.join('\n')}`);
    const elsewhere = p.requests.filter((url) => {
      if (/^(data|blob|about):/.test(url)) return false;
      const { hostname, port } = new URL(url);
      return hostname !== '127.0.0.1' || Number(port) === LIVE_PORT;
    });
    if (elsewhere.length) throw new Error(`requests to a host other than the mocks on 127.0.0.1:\n${elsewhere.join('\n')}`);
    return { failure: null, timedOut };
  } catch (err) {
    const file = join(FAILURES, `${slug(check.name)}--${lookName(look)}.png`);
    const shot = page ? await within(10_000, 'the screenshot', page.shot(file)).then(() => file, () => null) : null;
    return { failure: { err, file: shot }, timedOut };
  } finally {
    if (page) await within(10_000, 'closing the page', page.close()).catch(() => {});
    if (timedOut) await within(10_000, 'the timed-out check', running!).catch(() => {});
  }
}

// Results print in the order of the runs, each as soon as it and every run before it are done.
const results: (string | undefined)[] = [];
let printed = 0;
let failed = 0;
const report = (i: number, line: string) => {
  results[i] = line;
  while (results[printed] !== undefined) console.log(results[printed++]);
};

const startOwnMock = async () => {
  const mock = await startMock({ port: args.port ? Number(args.port) : undefined, dist: resolve(args.dist) });
  mocks.add(mock);
  return mock;
};

const startBrowser = async () => {
  const browser = await launch();
  browsers.add(browser);
  return browser;
};

async function work(next: () => number | undefined) {
  let mock = await startOwnMock();
  let browser = await startBrowser();
  for (let i = next(); i !== undefined; i = next()) {
    const [check, look] = runs[i];
    const started = Date.now();
    let failure: { err: unknown; file: string | null } | null;
    try {
      // A browser or mock that died takes down only the check it died in.
      if (!browser.alive()) {
        browsers.delete(browser);
        await browser.close().catch(() => {});
        browser = await startBrowser();
      }
      if (!mock.alive()) {
        mocks.delete(mock);
        mock = await startOwnMock();
      }
      const result = await runOne(mock, browser, check, look);
      failure = result.failure;
      if (result.timedOut && !args.port) {
        mocks.delete(mock);
        await mock.stop().catch(() => {});
        mock = await startOwnMock();
      }
    } catch (err) {
      failure = { err, file: null };
    }
    const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
    if (!failure) {
      report(i, `ok    ${check.name} [${lookName(look)}] ${took}`);
      continue;
    }
    failed++;
    const message = failure.err instanceof Error ? (failure.err.stack ?? failure.err.message) : String(failure.err);
    const shot = failure.file ? relative(process.cwd(), failure.file) : 'none';
    report(i, `FAIL  ${check.name} [${lookName(look)}] ${took}\n      ${message.split('\n').join('\n      ')}\n      screenshot: ${shot}`);
  }
}

const began = Date.now();
try {
  console.log(`e2e: ${runs.length} runs, ${workers} ${workers === 1 ? 'worker' : 'workers'}${args.port ? ` against the mock on port ${args.port}` : ''}`);
  let taken = 0;
  const next = () => (taken < runs.length ? taken++ : undefined);
  await Promise.all(Array.from({ length: workers }, () => work(next)));
  console.log(`${runs.length - failed} passed, ${failed} failed in ${Math.round((Date.now() - began) / 1000)} s`);
} finally {
  await stop();
}
process.exitCode = failed ? 1 : 0;
