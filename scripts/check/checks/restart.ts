import assert from 'node:assert/strict';
import { until } from '../cdp.ts';
import { logged, openQueue, openSheetOf, POSTED_MS, reachable, sidewaysScroll, type Check } from '../helpers.ts';
import type { UxRow } from '../mock.ts';

export const restart: Check[] = [
  {
    name: 'UX the usage recorder posts the screens, a board key, a key the board has no use for, a click and the cards shown, but not what the option said',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.key('ArrowRight');
      await page.key('q');
      const label = await page.eval(() => document.querySelector('[data-card] [data-option]')!.textContent!.trim());
      await page.click('[data-card] [data-option]');
      await page.goto(`${mock.url}/wall`);
      const events = await until('the recorded events', async () => {
        const all: UxRow[] = await mock.get('/mock/ux');
        return all.some((e) => e.name === 'screen') ? all : null;
      });
      assert.ok(events.some((e) => e.name === 'load'), 'the page load');
      assert.ok(events.some((e) => e.name === 'screen' && e.data?.screen === 'queue' && e.data.ms > 0), 'time on the queue');
      assert.ok(events.some((e) => e.name === 'key' && e.data?.action === 'skip' && e.data.keys === '→'), 'the skip key');
      assert.ok(events.some((e) => e.name === 'key-miss' && e.data?.key === 'q'), 'the unused key');
      assert.ok(events.some((e) => e.name === 'click' && e.data?.control === 'option' && e.data.area === 'queue/menu'), 'the option clicked');
      assert.ok(events.some((e) => e.name === 'card-shown' && e.task === 's-cart' && e.decision && e.data?.deck > 0), 'the card shown, with its decision and the deck size');
      assert.ok(label && !JSON.stringify(events).includes(label), `the option's text "${label}" is not recorded`);
    },
  },
  {
    name: 'UX.names every control on the Wall, a task\'s Overview, Diff and Conversation, its ⋯ menu and New task with its pickers open is recorded without the task, finding, file, branch, repository or link it names',
    scenario: 'findings',
    async run({ page, mock }) {
      const state = await mock.get('/api/state');
      const content = new Set<string>();
      const add = (v: unknown) => {
        if (typeof v === 'string' && v.trim().length >= 4) content.add(v.trim());
      };
      for (const s of state.sessions) {
        [s.title, s.firstPrompt, s.worktree, s.worktree.split('/').at(-1), s.summary?.text, s.parent?.title].forEach(add);
        for (const f of s.findings?.items ?? []) [f.title, f.location].forEach(add);
        for (const l of s.links ?? []) [l.url, l.about, l.text, l.context].forEach(add);
        for (const a of s.artifacts ?? []) add(a.title);
      }
      for (const r of state.repos) {
        add(r.name);
        for (const w of r.worktrees) [w.path, w.branch].forEach(add);
      }
      const COMMON = new Set(['main', 'master']);
      // Only the recorder sees these clicks: this listener, added after it on the window, stops them before the board
      // and cancels what a link or a popover button would do.
      const clickAll = (selector: string) => {
        const stop = (e: Event) => {
          e.stopImmediatePropagation();
          e.preventDefault();
        };
        addEventListener('click', stop, true);
        try {
          for (const el of document.querySelectorAll(selector)) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
        } finally {
          removeEventListener('click', stop, true);
        }
        return document.querySelectorAll(selector).length;
      };
      const CONTROLS = 'button, a[href], summary, select, [role="tab"], [role="option"], [role="menuitem"], input[type="checkbox"], input[type="radio"]';
      await page.goto(`${mock.url}/wall`);
      await page.until('the Wall', () => document.querySelectorAll('[data-tile]').length > 3);
      let clicked = await page.eval(clickAll, CONTROLS);
      // In-page navigation keeps the page and its unsent events.
      const go = (path: string) => page.eval((to: string) => void window.navigation.navigate(to), path);
      for (const tab of ['', '/diff', '/conversation']) {
        await go(`/s/s-review${tab}`);
        await page.until('the task page', () => !!document.querySelector('#task-sheet [role="tabpanel"] *'));
        if (tab === '/diff') await page.until('the file list', () => !!document.querySelector('#task-sheet [data-ux="file"]'));
        if (!tab) await page.click('#task-sheet button[aria-label="Session actions"]');
        clicked += await page.eval(clickAll, CONTROLS);
      }
      await go('/wall');
      await page.until('the task page to close', () => !document.querySelector('#task-sheet [role="tabpanel"]'));
      await page.click('header button[aria-label="New task"]');
      await page.click('dialog#new-task button[aria-haspopup="listbox"]');
      clicked += await page.eval(clickAll, '#new-task [role="option"], #new-task button[aria-haspopup]');
      if (!(await page.eval(() => !!document.querySelector<HTMLDialogElement>('dialog#new-task')?.open))) await page.click('header button[aria-label="New task"]');
      await page.click('dialog#new-task fieldset label', 'Current checkout');
      await page.click('dialog#new-task [data-branch-field] input');
      await page.until('the branch list', () => !!document.querySelector('#new-task [data-branch-picker]:popover-open button'));
      clicked += await page.eval(clickAll, '#new-task [data-branch-picker] button');
      // The page sends what it recorded every 15 s.
      const events = await until('the recorded clicks', async () => {
        const all: UxRow[] = await mock.get('/mock/ux');
        const clicks = all.filter((e) => e.name === 'click');
        return clicks.length >= clicked ? clicks : null;
      }, 20_000);
      const leaks = events.map((e) => String(e.data?.control)).filter((name) => /[/~]/.test(name) || [...content].some((c) => !COMMON.has(c) && name.includes(c)));
      assert.deepEqual([...new Set(leaks)], [], 'no control is recorded by what it names');
      assert.ok(events.some((e) => e.data?.control === 'finding') && events.some((e) => e.data?.control === 'file') && events.some((e) => e.data?.control === 'repository option'), 'content controls by their kind');
    },
  },
  {
    name: 'UX.reading an action records the Overview sections in view before it, for how long, and the screen time leaves out what passed with no one at the board',
    scenario: 'findings',
    clock: 'fast',
    async run({ page, mock, wait }) {
      await page.goto(`${mock.url}/s/s-review`);
      await page.until('the Overview', () => !!document.querySelector('[data-ux-section="findings"]'));
      await page.pointAt(400, 300);
      await wait(3000);
      await page.click('#task-sheet [role="tab"]', 'Diff');
      const read = await until('the reading before the click', async () => {
        const all: UxRow[] = await mock.get('/mock/ux');
        return all.find((e) => e.name === 'read' && e.data?.control === 'Diff') ?? null;
      });
      assert.equal(read.data!.screen, 'task/overview');
      assert.equal(read.data!.action, 'click');
      assert.ok(read.data!.sections.findings >= 2000, `findings were in view for ${read.data!.sections.findings} ms`);
      assert.ok(read.data!.sections['message box'] >= 2000, `the message box was in view for ${read.data!.sections['message box']} ms`);
      assert.ok(!('links' in read.data!.sections), 'a section the task does not have is not read');
    },
  },
  {
    name: 'diff-tab the Diff tab counts the changed files, with their lines on hover, and says none when the worktree has no changes',
    scenario: 'findings',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-review`);
      const tab = () => {
        const t = [...document.querySelectorAll<HTMLElement>('#task-sheet [role="tab"]')].find((b) => b.innerText.startsWith('Diff'));
        return t ? { text: t.innerText.replace(/\s+/g, ' ').trim(), title: t.dataset.explain, changes: t.dataset.changes ?? null } : null;
      };
      assert.deepEqual(await page.until('the Diff tab', tab), { text: 'Diff 5 3', title: '5 files changed: +96 −12', changes: '5' });
      await shot('diff-tab-changes');
      await mock.post('/mock/patch', { id: 's-review', patch: { diffstat: { files: 0, insertions: 0, deletions: 0 } } });
      assert.deepEqual(await page.until('the tab with no changes', () => {
        const t = [...document.querySelectorAll<HTMLElement>('#task-sheet [role="tab"]')].find((b) => b.innerText.startsWith('Diff'));
        return t?.innerText.includes('none') ? { text: t.innerText.replace(/\s+/g, ' ').trim(), title: t.dataset.explain, changes: t.dataset.changes ?? null } : null;
      }), { text: 'Diff none 3', title: 'No changes against the base branch', changes: null });
    },
  },
  {
    name: 'new-task.default New task first opens on Current checkout with the default branch picked and the repository focused, More folded under the prompt; ⌘↵ creates there; the repository, mode and More outlast a reload; More opens the model and effort, and names what is set in them while folded',
    newTask: 'default',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.click('header button[aria-label="New task"]');
      const form = () => {
        const d = document.querySelector<HTMLDialogElement>('dialog#new-task');
        if (!d?.open) return null;
        const branch = d.querySelector<HTMLInputElement>('[data-branch-field] input');
        if (!branch?.value) return null;
        return {
          mode: d.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.parentElement?.innerText.trim() ?? null,
          branch: branch?.value ?? null,
          focused: document.activeElement === d.querySelector('button[aria-haspopup="listbox"]') ? 'repository' : document.activeElement?.tagName.toLowerCase() ?? null,
          prompt: !!d.querySelector('textarea'),
          options: !!d.querySelector('[data-more-options]'),
          more: d.querySelector<HTMLElement>('[data-more]')?.innerText.trim() ?? null,
        };
      };
      assert.deepEqual(await page.until('New task', form), { mode: 'Current checkout', branch: 'main', focused: 'repository', prompt: true, options: false, more: 'More' });
      await shot('new-task-folded');
      await page.click('dialog#new-task [data-more]');
      await page.until('the options', () => !!document.querySelector('dialog#new-task [data-more-options]'));
      await page.eval(() => {
        const select = document.querySelectorAll<HTMLSelectElement>('dialog#new-task select')[0];
        select.value = select.options[1].value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.click('dialog#new-task [data-more]');
      const folded = await page.until('More folded, naming the model', () => {
        const m = document.querySelector<HTMLElement>('dialog#new-task [data-more]');
        return m && !document.querySelector('dialog#new-task [data-more-options]') ? m.innerText.trim() : null;
      });
      assert.match(folded, /^More\s*\S+/);
      await page.click('dialog#new-task [data-more]');
      await shot('new-task-more');
      await page.click('dialog#new-task [data-more]');
      await page.goto(`${mock.url}/wall`);
      await page.click('header button[aria-label="New task"]');
      assert.equal((await page.until('New task after the reload', form))!.mode, 'Current checkout');
      await page.until('the repository focused', () => document.activeElement === document.querySelector('dialog#new-task button[aria-haspopup="listbox"]'));
      await page.eval(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })));
      const [made] = await logged(mock, 'the task made', (e) => e.method === 'POST' && e.path === '/api/worktrees');
      assert.deepEqual([made.body.existingBranch, made.body.branch, made.body.prompt], [true, 'main', '']);
    },
  },
  {
    name: 'P1 Pause waits for every turn to end, Stop now cuts the rest short, each Claude stops its background tasks and the banner says it is safe to close the laptop or restart; Resume on a task page or Resume all carries on',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      type Row = { id: string; status: string; title: string | null; parent: unknown; archived: boolean; activity: { between?: true } | null; interrupted: { cause?: string } | null };
      const all = (await mock.get('/api/state')).sessions as Row[];
      const inTurn = all.filter((s) => s.status === 'working' && !s.activity?.between);
      assert.ok(inTurn.length > 1);
      const ends = inTurn[0];
      await page.click('header button[data-pause]');
      const waiting = await page.until('the pausing banner', () => document.querySelector<HTMLElement>('[data-pause="stopping"]')?.innerText ?? null);
      assert.match(waiting, /Pausing · waiting for .* to finish their turns \(the longest has run /);
      for (const s of inTurn) if (s.title) assert.ok(waiting.includes(s.title), `names ${s.title}`);
      await shot('pausing');
      assert.equal((await mock.log()).filter((e) => e.path === '/api/pause/now').length, 0, 'no Esc until Stop now');

      const idle = all.find((s) => s.status === 'idle' && !s.archived && !s.parent)!;
      await mock.post('/mock/patch', { id: idle.id, patch: { status: 'working', activity: { step: null, since: Date.now() } } });
      await mock.post('/mock/patch', { id: ends.id, patch: { status: 'idle', activity: null } });
      const working = [...inTurn, idle, ...all.filter((s) => s.status === 'working' && s.activity?.between)];
      await page.until('a turn you started is waited on too', (t: string) => document.querySelector<HTMLElement>('[data-pause="stopping"]')?.innerText.includes(t) || null, idle.title ?? idle.id);
      await page.click('[data-pause="stopping"] button[data-stop-now]');
      await logged(mock, 'Stop now', (e) => e.path === '/api/pause/now');
      const paused = await page.until('Safe to close the laptop', () => document.querySelector<HTMLElement>('[data-pause="paused"]')?.innerText ?? null);
      assert.match(paused, /Paused .*Safe to close the laptop or restart the Mac\./);
      assert.equal(await page.eval(() => document.querySelectorAll('section[data-pause], section[data-restart]').length), 1, 'no restart, so the pause has its own banner');
      const state = (await mock.get('/api/state')).sessions as Row[];
      assert.deepEqual(state.filter((s) => s.interrupted?.cause === 'pause').map((s) => s.id).sort(), working.map((s) => s.id).sort());
      assert.equal(state.filter((s) => s.status === 'working').length, 0, 'nothing runs any more');
      const labels = await page.eval(() => [...document.querySelectorAll('[data-tile]')].map((t) => t.getAttribute('aria-label') ?? ''));
      assert.equal(labels.filter((l) => l.endsWith(', Paused')).length, working.filter((s) => !s.parent).length);
      await shot('paused');

      const first = working.find((s) => s.title && !s.parent)!;
      await page.click('[data-pause="paused"] button', first.title!);
      await page.click('#task-sheet [data-interrupted="paused"] button', 'Resume');
      const [one] = await logged(mock, 'the resume of one', (e) => e.path === '/api/pause/resume');
      assert.equal(one.body.id, first.id);
      await page.until('its note to go once Claude works', () => !document.querySelector('#task-sheet [data-interrupted]'));
      await page.goto(`${mock.url}/wall`);
      await page.click('[data-pause="paused"] button', 'Resume all');
      await page.until('the banner to go once every Claude works', () => !document.querySelector('section[data-pause]'));
      const after = (await mock.get('/api/state')).sessions as typeof all;
      assert.equal(after.filter((s) => s.interrupted).length, 0);
    },
  },
  {
    name: 'R1 after a restart the banner counts the tasks it ended; Resume all brings them back, the ones cut short mid-turn stay marked until Continue the turn',
    scenario: 'restarted',
    clock: 'fast',
    async run({ page, mock, shot }) {
      const before = (await mock.get('/api/state')).sessions as { id: string; status: string; archived: boolean; parent: unknown; interrupted: { status: string } | null }[];
      const ended = before.filter((s) => s.interrupted && !s.archived);
      const subtasks = ended.filter((s) => s.parent).length;
      const midTurn = ended.filter((s) => s.interrupted!.status !== 'idle');
      assert.ok(ended.length > 3 && midTurn.length > 1 && midTurn.length < ended.length, 'the scenario has tasks of every kind');
      await page.goto(`${mock.url}/wall`);
      const banner = await page.until('the recovery banner', () => document.querySelector<HTMLElement>('[data-restart="recover"]')?.innerText ?? null);
      assert.match(banner, new RegExp(`The Mac restarted and ended ${ended.length - subtasks} tasks and ${subtasks} subtasks with it: .*\\d+ in progress`));
      assert.doesNotMatch(banner, /Paused/, 'nothing was paused, so the banner reads as before');
      assert.equal(await page.eval(() => document.querySelectorAll('section[data-pause], section[data-restart]').length), 1);
      const labels = await page.eval(() => [...document.querySelectorAll('[data-tile]')].map((t) => t.getAttribute('aria-label') ?? ''));
      assert.equal(labels.filter((l) => l.endsWith(', Ended by restart')).length, ended.length - subtasks, 'subtasks have no tile of their own');
      assert.equal(labels.filter((l) => l.endsWith(', Ended')).length, 2, 'the two that had ended before the restart');
      await shot('restart-recover');

      await page.click('[data-restart="recover"] button', 'Resume all');
      const [resumed] = await logged(mock, 'the resume', (e) => e.path === '/api/restart/resume');
      assert.equal(resumed.status, 200);
      assert.equal(resumed.body.paused, undefined);
      const cut = await page.until('the mid-turn banner', () => {
        const b = document.querySelector<HTMLElement>('[data-restart="recover"]');
        return b?.innerText.includes('cut short mid-turn') ? [...b.querySelectorAll('button')].map((x) => x.textContent) : null;
      });
      assert.deepEqual(cut.slice(-1), ['Dismiss']);
      assert.equal(cut.length, midTurn.length + 1, 'a link to each task cut short, and Dismiss');
      const state = (await mock.get('/api/state')).sessions as typeof before;
      assert.equal(state.filter((s) => ended.some((e) => e.id === s.id) && s.status === 'exited').length, 0, 'every task came back');
      assert.equal(state.filter((s) => s.interrupted).length, midTurn.length, 'the ones that only waited for you are as they were');
      await shot('restart-cut-short');

      await page.click('[data-restart="recover"] button', cut[0]!);
      const id = await page.until('its page', () => location.pathname.match(/^\/s\/([^/]+)/)?.[1] ?? null);
      assert.ok(midTurn.some((s) => s.id === id));
      await page.click('#task-sheet [data-interrupted="cut-short"] button', 'Continue the turn');
      const [sent] = await logged(mock, 'the continue', (e) => e.action === 'answer' && e.sessionId === id, POSTED_MS);
      assert.match(String(sent.body.text), /The Mac restarted while you were working/);
      await page.until('the note to go once Claude works', () => !document.querySelector('#task-sheet [data-interrupted]'));
      const left = await page.until('one fewer in the banner', (n: number) => {
        const b = document.querySelector<HTMLElement>('[data-restart="recover"]');
        return b && b.querySelectorAll('button').length === n ? true : null;
      }, midTurn.length);
      assert.ok(left);
    },
  },
  {
    name: 'R2 a task Resume all cannot bring back says why in a toast and stays ended; Dismiss forgets the rest',
    scenario: 'restartedFails',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/wall`);
      await page.click('[data-restart="recover"] button', 'Resume all');
      const message = await page.until('the toast', () => document.querySelector<HTMLElement>('[data-toast]')?.innerText ?? null);
      assert.match(message, /Not resumed: conversation not found in this worktree/);
      const text = await page.until('the banner for the one left', () => {
        const b = document.querySelector<HTMLElement>('[data-restart="recover"]');
        return b?.innerText.includes('ended 1 task with it') ? b.innerText : null;
      });
      assert.match(text, /Resume all/);
      await page.click('[data-restart="recover"] button', 'Dismiss');
      await page.until('the banner to go', () => !document.querySelector('[data-restart]'));
      const [dismissed] = await logged(mock, 'the dismiss', (e) => e.path === '/api/restart/dismiss');
      assert.equal(dismissed.body.paused, undefined);
      const state = (await mock.get('/api/state')).sessions as { interrupted: unknown }[];
      assert.equal(state.filter((s) => s.interrupted).length, 0);
    },
  },
  {
    name: 'R6 after a restart that followed a pause, one banner names the paused tasks and counts the ones the restart ended; one Resume all has the paused ones carry on on the resume prompt and brings the others back as they were, the ones cut short mid-turn still marked',
    scenario: 'restartedPaused',
    async run({ page, mock, shot }) {
      type Row = { id: string; title: string | null; status: string; archived: boolean; parent: unknown; interrupted: { status: string; cause?: string } | null };
      const before = (await mock.get('/api/state')).sessions as Row[];
      const held = before.filter((s) => s.interrupted?.cause === 'pause');
      const ended = before.filter((s) => s.interrupted && s.interrupted.cause !== 'pause' && !s.archived);
      const midTurn = ended.filter((s) => s.interrupted!.status !== 'idle');
      assert.ok(held.length > 1 && held.some((s) => s.parent) && ended.length > 1 && midTurn.length > 0, 'the scenario has paused tasks, a paused subtask and tasks the restart ended');
      await page.goto(`${mock.url}/wall`);
      const banner = await page.until('the one banner', () => document.querySelector<HTMLElement>('[data-restart="recover"][data-paused]')?.innerText ?? null);
      assert.equal(await page.eval(() => document.querySelectorAll('section[data-pause], section[data-restart]').length), 1, 'the pause has no banner of its own');
      const tasks = (list: Row[]) => list.filter((s) => !s.parent).length;
      assert.match(banner, new RegExp(`^The Mac restarted and ended ${tasks(ended)} tasks and 1 subtask with it: .+\\. Paused ${tasks(held)} tasks and 1 subtask: `));
      for (const s of held) assert.ok(banner.includes(s.title!), `names ${s.title}`);
      assert.match(banner, /Resume all has each paused one start its background tasks again and carry on, and continues the others where they were\./);
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll('[data-restart="recover"] > button')].map((b) => b.textContent)), ['Resume all', 'Dismiss'], 'one Resume all, one Dismiss');
      const labels = await page.eval(() => [...document.querySelectorAll('[data-tile]')].map((t) => t.getAttribute('aria-label') ?? ''));
      assert.equal(labels.filter((l) => l.endsWith(', Paused')).length, tasks(held));
      assert.equal(labels.filter((l) => l.endsWith(', Ended by restart')).length, tasks(ended));
      await shot('restart-after-pause');

      await page.click('[data-restart="recover"] button', 'Resume all');
      const [resumed] = await logged(mock, 'the resume', (e) => e.path === '/api/restart/resume');
      assert.deepEqual([resumed.status, resumed.body.paused], [200, true]);
      const cut = await page.until('the mid-turn banner', () => {
        const b = document.querySelector<HTMLElement>('[data-restart="recover"]');
        return b?.innerText.includes('cut short mid-turn') ? b.innerText : null;
      });
      assert.doesNotMatch(cut, /Paused/);
      const state = await until('the paused ones to carry on', async () => {
        const all = (await mock.get('/api/state')).sessions as Row[];
        return all.filter((s) => held.some((o) => o.id === s.id)).every((s) => s.status === 'working' && !s.interrupted) ? all : null;
      });
      assert.equal(state.filter((s) => [...held, ...ended].some((o) => o.id === s.id) && s.status === 'exited').length, 0, 'every task came back');
      assert.equal(state.filter((s) => s.interrupted).length, midTurn.length, 'the ones that only waited for you are as they were');
      await page.until('the pause banner to go', () => !document.querySelector('section[data-pause]'));
    },
  },
  {
    name: 'R7 after a restart that followed a pause, one Dismiss forgets the restart and the pause; a paused task Resume all cannot bring back says why in a toast and stays paused',
    scenario: 'restartedPausedFails',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/wall`);
      await page.click('[data-restart="recover"][data-paused] button', 'Dismiss');
      const [dismissed] = await logged(mock, 'the dismiss', (e) => e.path === '/api/restart/dismiss');
      assert.equal(dismissed.body.paused, true);
      await page.until('every banner to go', () => !document.querySelector('section[data-restart], section[data-pause]'));
      const state = (await mock.get('/api/state')).sessions as { id: string; title: string; status: string; interrupted: { cause?: string } | null }[];
      assert.equal(state.filter((s) => s.interrupted).length, 0, 'the pause is forgotten too');

      await mock.post('/mock/scenario/restartedPausedFails', {});
      const failing = ((await mock.get('/api/state')).sessions as typeof state).find((s) => s.interrupted?.cause === 'pause' && !('parent' in s && s.parent))!;
      await page.goto(`${mock.url}/wall`);
      await page.click('[data-restart="recover"][data-paused] button', 'Resume all');
      const message = await page.until('the toast', () => document.querySelector<HTMLElement>('[data-toast]')?.innerText ?? null);
      assert.match(message, /Not resumed: conversation not found in this worktree/);
      const left = await page.until('the pause banner for the one left', () => {
        const text = document.querySelector<HTMLElement>('[data-pause="paused"]')?.innerText ?? '';
        return text.startsWith('Paused 1 task: ') ? text : null;
      });
      assert.ok(left.includes(failing.title), left);
      const after = ((await mock.get('/api/state')).sessions as typeof state).find((s) => s.id === failing.id)!;
      assert.deepEqual([after.status, after.interrupted?.cause], ['exited', 'pause']);
    },
  },
  {
    name: 'R4 narrow: the restart banner fits the window, Resume all stays in reach',
    narrow: true,
    scenario: 'restarted',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('Resume all in reach', reachable, '[data-restart] button', 'Resume all');
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await shot('narrow-restart-recover');
      await mock.post('/mock/scenario/restartedPaused', {});
      await page.goto(`${mock.url}/wall`);
      await page.until('the banner after a pause', () => !!document.querySelector('[data-restart="recover"][data-paused]'));
      await page.until('Resume all in reach', reachable, '[data-restart] button', 'Resume all');
      await page.until('Dismiss in reach', reachable, '[data-restart] button', 'Dismiss');
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await shot('narrow-restart-after-pause');
    },
  },
  {
    name: 'R3 narrow: the pausing banner fits the window, Stop now and Cancel stay in reach',
    narrow: true,
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      await mock.post('/api/pause', {});
      await page.until('Stop now in reach', reachable, '[data-pause] button', 'Stop now');
      await page.until('Cancel in reach', reachable, '[data-pause] button', 'Cancel');
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await shot('narrow-pausing');
      await page.click('[data-pause] button', 'Cancel');
      await page.until('the banner to go', () => !document.querySelector('section[data-pause]'));
    },
  },
  {
    name: 'R5 subtasks the restart ended show on their root task\'s tile as Ended by restart, until resumed or archived; the banner counts them apart and names each one\'s task',
    scenario: 'restarted',
    async run({ page, mock, shot }) {
      const all = (await mock.get('/api/state')).sessions as { id: string; title: string; parent: { id: string } | null }[];
      const fix = all.find((s) => s.id === 's-restart-fix')!;
      const task = all.find((s) => s.id === fix.parent!.id)!;
      await page.goto(`${mock.url}/wall`);
      const listed = () => [...document.querySelectorAll('[data-tile] [data-restart-subtask]')].map((li) => ({
        tile: li.closest('[data-tile]')!.getAttribute('data-session'), id: li.getAttribute('data-restart-subtask'), text: (li as HTMLElement).innerText.replace(/\s+/g, ' '),
      }));
      const shown = await page.until('the subtasks on their task\'s tile', () => {
        const l = [...document.querySelectorAll('[data-tile] [data-restart-subtask]')];
        return l.length === 2 ? true : null;
      });
      assert.ok(shown);
      assert.deepEqual(await page.eval(listed), [
        { tile: task.id, id: 's-restart-fix', text: 'ENDED BY RESTART Fix #1 retry backoff' },
        { tile: task.id, id: 's-restart-look', text: 'ENDED BY RESTART Second look #1.1 backoff cap' },
      ]);
      assert.match(await page.eval(() => document.querySelector<HTMLElement>('[data-restart="recover"]:not([data-paused])')!.innerText), / tasks and 2 subtasks with it: /);
      await shot('restart-subtasks-tile');

      await mock.post('/mock/patch', { id: 's-restart-look', patch: { archived: true } });
      await page.until('the archived one to leave the tile', () => document.querySelectorAll('[data-restart-subtask]').length === 1);
      await page.click('[data-tile] [data-restart-subtask] button', 'Fix #1 retry backoff');
      await page.until('the subtask\'s page', () => location.pathname.startsWith('/s/s-restart-fix'));
      await page.goto(`${mock.url}/wall`);

      await page.click('[data-restart="recover"] button', 'Resume all');
      const cut = await page.until('the mid-turn banner', () => {
        const b = document.querySelector<HTMLElement>('[data-restart="recover"]');
        return b?.innerText.includes('cut short mid-turn') ? b.innerText : null;
      });
      assert.match(cut, /^\d+ tasks and 1 subtask were cut short mid-turn by the restart: /);
      assert.ok(cut.includes(`Fix #1 retry backoff (subtask of ${task.title})`), cut);
      await page.until('the tile to drop it once resumed', () => !document.querySelector('[data-restart-subtask]'));
    },
  },
  {
    name: 'E1 a turn that ended on an API error says Stopped on an error on its tile and page, with what to do for its kind and Try again unless it was refused, until Claude replies again',
    async run({ page, mock, shot }) {
      const all = (await mock.get('/api/state')).sessions as { id: string; status: string; archived: boolean; question: unknown; menu: unknown; summary: { decision?: unknown } | null }[];
      const s = all.find((o) => o.status === 'idle' && !o.archived && !o.question && !o.menu && !o.summary?.decision)!;
      const refused = "API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations.\n\nDouble press esc to edit your last message, or try a different model with /model.";
      await mock.post('/mock/patch', { id: s.id, patch: { turnError: { at: Date.now(), kind: 'refusal', text: refused } } });
      await page.goto(`${mock.url}/wall`);
      const tile = await page.until('the tile to say so', (id: string) => {
        const state = document.querySelector<HTMLElement>(`[data-tile][data-session="${id}"] [data-error]`);
        const t = state?.closest<HTMLElement>('[data-tile]');
        return t && { text: state!.innerText, title: state!.dataset.explain ?? "", label: t.getAttribute('aria-label'), says: t.querySelector('p')?.textContent };
      }, s.id);
      assert.equal(tile.says, "The model's safeguards flagged your last message; rephrase it");
      assert.equal(tile.text, 'STOPPED ON AN ERROR');
      assert.match(tile.title, /ended on an API error/);
      assert.match(tile.label!, /, Stopped on an error$/);
      assert.equal(await page.eval(() => document.querySelectorAll('[data-tile] [data-error]').length), 1, 'only the one that errored');
      await shot('turn-error-tile');

      await openSheetOf(page, mock, s.id);
      const panel = await page.until('the error on its page', () => {
        const p = document.querySelector<HTMLElement>('#task-sheet [data-turn-error]');
        return p && { kind: p.dataset.turnError, text: p.innerText, quote: p.querySelector('blockquote')?.textContent, buttons: [...p.querySelectorAll('button')].map((b) => b.textContent) };
      });
      assert.equal(panel.kind, 'refusal');
      assert.match(panel.text, /safeguards flagged your last message/);
      assert.match(panel.text, /rephrase it/);
      assert.equal(panel.quote, "Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations.");
      assert.deepEqual(panel.buttons, ['Terminal']);
      assert.ok(await page.eval(() => !!document.querySelector('#task-sheet [data-error]')), 'the page header says so too');
      assert.ok(await page.eval(() => !!document.querySelector('#task-sheet textarea')), 'a message can still be written');
      await shot('turn-error-page');

      await mock.post('/mock/patch', { id: s.id, patch: { turnError: { at: Date.now(), kind: 'limit', text: "You've hit your session limit · resets 2pm (Europe/Prague)" } } });
      const limit = await page.until('the limit advice', () => {
        const p = document.querySelector<HTMLElement>('#task-sheet [data-turn-error="limit"]');
        return p && { text: p.innerText, buttons: p.querySelectorAll('button').length };
      });
      assert.match(limit.text, /usage limit[\s\S]*resets 2pm/);
      assert.equal(limit.buttons, 1);

      await mock.post('/mock/patch', { id: s.id, patch: { turnError: { at: Date.now(), kind: 'other', text: 'API Error: 500 Internal server error.' } } });
      await page.until('the failed request', () => document.querySelector('#task-sheet [data-turn-error="other"]')?.textContent?.includes('500 Internal server error') || null);
      await page.click('#task-sheet [data-turn-error="other"] button', 'Try again');
      const [sent] = await logged(mock, 'the retry', (e) => e.action === 'answer' && e.sessionId === s.id, POSTED_MS);
      assert.match(String(sent.body.text), /stopped on an API error before you replied/);

      await mock.post('/mock/patch', { id: s.id, patch: { status: 'idle', turnError: null } });
      await page.until('the error to go once Claude replies', () => !document.querySelector('#task-sheet [data-turn-error], #task-sheet [data-error]'));
    },
  },
];
