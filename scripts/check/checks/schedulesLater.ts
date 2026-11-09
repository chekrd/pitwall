import assert from 'node:assert/strict';
import { sleep } from '../cdp.ts';
import { logged, matches, openNewTask, openQueue, openSheetOf, pickRepo, sheetOpen, stateOf, tiles, typeInPrompt, type Check } from '../helpers.ts';

export const schedulesLater: Check[] = [
  {
    name: 'S1 New task can repeat: Repeat under More offers weekdays at 09:00, needs a prompt, and the button reads Schedule; ⌘↵ posts the schedule, says so in a toast and lists it under Scheduled on the Wall, folded like Archived until opened, the link under the heading opening it, with its next run; Run now opens a task named by the date whose facts name the schedule; Pause and Resume, and Delete with Undo',
    async run({ page, mock, shot }) {
      const submit = () => document.querySelector('dialog#new-task textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      assert.equal(await page.eval(() => !!document.querySelector('[data-schedules]')), false, 'no Scheduled list without a schedule');
      await openNewTask(page);
      await pickRepo(page, 'storefront');
      await page.click('dialog#new-task input[placeholder="fix-login-redirect"]');
      await page.type('nightly-review');
      await page.click('dialog#new-task [data-when] label', 'Repeat');
      const form = await page.until('the repeat fields', () => {
        const when = document.querySelector('dialog#new-task [data-when]');
        const time = when?.querySelector<HTMLInputElement>('input[type="time"]');
        const button = document.querySelector<HTMLButtonElement>('dialog#new-task button[type="submit"]')!;
        return time && {
          time: time.value,
          days: [...when!.querySelectorAll<HTMLInputElement>('[data-days] input')].map((i) => i.checked),
          button: button.textContent, disabled: button.disabled,
        };
      });
      assert.deepEqual(form, { time: '09:00', days: [true, true, true, true, true, false, false], button: 'Schedule ↵', disabled: true });
      await typeInPrompt(page);
      await page.type('Review the open PRs and summarise what needs me');
      await page.until('Schedule enabled with a prompt', () => !document.querySelector<HTMLButtonElement>('dialog#new-task button[type="submit"]')!.disabled);
      assert.match(await page.eval(() => document.querySelector('dialog#new-task [data-when-hint]')!.textContent), /weekdays at 09:00, a new one each time, named nightly-review- and the date/);
      await shot('new-task-repeat');
      const rows = () => [...document.querySelectorAll('dialog#new-task [data-more-options] > div')].map((row) =>
        [...row.querySelectorAll(':scope > label, :scope > [data-when] > label, :scope > [data-when] > fieldset:not([data-days]), :scope > div > label')].map((el) => el.querySelector('span')?.textContent ?? 'Start'));
      assert.deepEqual(await page.eval(rows), [['Branch', 'Worktree path', 'Start', 'At'], ['Model', 'Effort']], 'a new worktree: Start by the worktree path, Model and Effort under it');
      await page.click('dialog#new-task label', 'Current checkout');
      await page.until('one row of options', () => document.querySelectorAll('dialog#new-task [data-more-options] > div').length === 1);
      assert.deepEqual(await page.eval(rows), [['Start', 'At', 'Model', 'Effort']], 'the current checkout: Start first, then Model and Effort');
      await shot('new-task-repeat-checkout');
      await page.click('dialog#new-task label', 'New worktree');
      await page.eval(submit);
      const [posted] = await logged(mock, 'the schedule', (e) => e.method === 'POST' && e.path === '/api/schedules');
      assert.equal(posted.status, 200);
      assert.deepEqual(posted.body.when, { time: '09:00', days: [1, 2, 3, 4, 5] });
      assert.deepEqual({ ...posted.body.task, name: posted.body.name }, {
        kind: 'repo', repoId: 1, existingBranch: false, branch: '', path: '', prompt: 'Review the open PRs and summarise what needs me', files: [], model: '', effort: '', name: 'nightly-review',
      });
      await page.until('the dialog closed', () => !document.querySelector<HTMLDialogElement>('dialog#new-task')!.open);
      await page.until('the toast', () => [...document.querySelectorAll('[data-toast]')].some((t) => /Scheduled nightly-review: weekdays at 09:00/.test(t.textContent)));
      assert.deepEqual(await page.until('Scheduled folded on the Wall', () => {
        const d = document.querySelector<HTMLDetailsElement>('details[data-schedules]');
        return d && { open: d.open, summary: d.querySelector('summary')!.textContent, rows: d.querySelectorAll('[data-schedule]').length };
      }), { open: false, summary: 'Scheduled (1)', rows: 0 });
      assert.match(await page.eval(() => document.querySelector('[data-scheduled-link]')!.textContent), /^1 scheduled, next .+ at 09:00$/);
      await page.click('[data-scheduled-link]');
      const row = await page.until('the schedule on the Wall', () => {
        const r = document.querySelector<HTMLElement>('details[data-schedules][open] [data-schedule="nightly-review"]');
        return r && { text: r.innerText, next: r.querySelector('[data-next]')!.textContent };
      });
      assert.match(row.text, /storefront · weekdays at 09:00/);
      assert.match(row.next, /^Next .+ at 09:00$/);
      await page.until('the list scrolled into view', () => {
        const r = document.querySelector('[data-schedules]')!.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      });
      await page.eval(() => document.querySelector('[data-schedules]')!.scrollIntoView({ block: 'center' }));
      await shot('wall-scheduled');

      const startOf = () => [...document.querySelectorAll<HTMLInputElement>('dialog#new-task [data-when] input[name="start"]')].findIndex((i) => i.checked);
      await openNewTask(page);
      await page.click('dialog#new-task [data-when] label', 'Once');
      await page.until('Once picked', () => !!document.querySelector('dialog#new-task input[type="datetime-local"]'));
      await page.key('Escape');
      await page.until('the dialog closed', () => !document.querySelector<HTMLDialogElement>('dialog#new-task')!.open);
      await openNewTask(page);
      assert.equal(await page.eval(startOf), 0, 'New task opens on Now, after a schedule and after Once was left picked');
      await page.click('dialog#new-task [data-when] label', 'Repeat');
      await page.goto(`${mock.url}/wall`);
      await page.click('[data-schedules] summary', 'Scheduled (1)');
      await page.until('the schedule after a reload', () => !!document.querySelector('[data-schedule="nightly-review"]'));
      await openNewTask(page);
      assert.equal(await page.eval(startOf), 0, 'and after a reload');
      await page.key('Escape');
      await page.until('the dialog closed', () => !document.querySelector<HTMLDialogElement>('dialog#new-task')!.open);
      await page.click('[data-schedule="nightly-review"] button', 'Run now');
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      await page.until('the run\'s sheet', (name: string) => !!document.querySelector('#task-sheet') && document.querySelector('#task-sheet h2')?.textContent === name, `nightly-review-${today}`);
      const facts = await page.until('its facts', () => {
        const dl = document.querySelector('#task-sheet dl');
        return dl && Object.fromEntries([...dl.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
      });
      assert.match(facts.Schedule ?? '', /^nightly-review, started with Run now today at \d\d:\d\d$/);
      await page.click('#task-sheet button[aria-label^="Back to"]');
      await page.until('the Wall', () => !document.querySelector('#task-sheet') && location.pathname === '/wall');
      await page.until('the last run', () => document.querySelector('[data-schedule="nightly-review"] [data-last="ran"]')?.textContent?.startsWith('Ran today at'));

      await page.click('[data-schedule="nightly-review"] button', 'Pause');
      await page.until('paused', () => document.querySelector('[data-schedule="nightly-review"]')?.hasAttribute('data-paused') &&
        document.querySelector('[data-schedule="nightly-review"] [data-next]')?.textContent === 'Paused');
      await page.click('[data-schedule="nightly-review"] button', 'Resume');
      await page.until('resumed', () => document.querySelector('[data-schedule="nightly-review"] [data-next]')?.textContent?.startsWith('Next '));

      await page.click('[data-schedule="nightly-review"] button[aria-label="Delete nightly-review"]');
      await page.until('the list gone', () => !document.querySelector('[data-schedules]'));
      await page.click('[data-toast] button', 'Undo');
      await page.until('the schedule back', () => !!document.querySelector('[data-schedule="nightly-review"]'));
      await page.click('[data-schedule="nightly-review"] button[aria-label="Delete nightly-review"]');
      await page.until('the list gone again', () => !document.querySelector('[data-schedules]'));
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.key('z', { meta: true });
      await page.until('the schedule back by ⌘Z', () => !!document.querySelector('[data-schedule="nightly-review"]'));
    },
  },
  {
    name: 'S2 a one-off missed while the Mac slept starts once when it wakes: its task says it started late and why, and the schedule reads Done with the run; a step after starts nothing more',
    async run({ page, mock, shot }) {
      const due = Math.ceil(Date.now() / 60_000) * 60_000 + 3_600_000;
      const schedule = await mock.post('/api/schedules', {
        name: 'after-lunch', when: { at: due },
        task: { kind: 'repo', repoId: 1, existingBranch: false, branch: '', path: '', prompt: 'Bump the dependencies', model: '', effort: '' },
      });
      await page.goto(`${mock.url}/wall`);
      await page.click('[data-schedules] summary', 'Scheduled (1)');
      await page.until('the schedule', () => /^Next (today|tomorrow) at/.test(document.querySelector('[data-schedule="after-lunch"] [data-next]')?.textContent ?? ''));
      const before = (await mock.get('/api/state')).sessions.length;
      await mock.post('/mock/schedules/step', { at: due - 60_000 });
      assert.equal((await mock.get('/api/state')).sessions.length, before, 'not before it is due');
      await mock.post('/mock/schedules/step', { at: due + 3 * 3_600_000 });
      await mock.post('/mock/schedules/step', { at: due + 3 * 3_600_000 + 60_000 });
      const { sessions, schedules } = await mock.get('/api/state');
      assert.equal(sessions.length, before + 1, 'one task for the missed run');
      const [s] = schedules;
      assert.equal(s.id, schedule.id);
      assert.equal(s.next, null);
      assert.equal(s.last.due, due);
      await page.until('Done, with the run', () => document.querySelector('[data-schedule="after-lunch"] [data-next]')?.textContent === 'Done' &&
        !!document.querySelector('[data-schedule="after-lunch"] [data-last="ran"]'));
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll('[data-schedule="after-lunch"] button:not([data-last])')].map((b) => b.textContent || b.getAttribute('aria-label'))), ['Run now', 'Delete after-lunch']);
      await page.eval(() => document.querySelector('[data-schedules]')!.scrollIntoView({ block: 'center' }));
      await shot('wall-scheduled-done');
      await page.click('[data-schedule="after-lunch"] [data-last="ran"]');
      const note = await page.until('the schedule fact', () => document.querySelector('#task-sheet [data-scheduled]')?.textContent);
      assert.match(note, /^after-lunch, due (today|tomorrow) at \d\d:\d\d; started (today|tomorrow) at \d\d:\d\d, as the Mac was asleep or Pitwall was not running then$/);
    },
  },
  {
    name: 'S3 narrow: a schedule on the Wall fits the window, its Run now, Pause and Delete in reach',
    narrow: true,
    async run({ page, mock, shot }) {
      await mock.post('/api/schedules', {
        name: 'weekly-dependency-bump', when: { time: '07:30', days: [1] },
        task: { kind: 'repo', repoId: 1, existingBranch: true, branch: 'main', path: '', prompt: 'Bump the dependencies and open a PR when the checks pass', model: '', effort: '' },
      });
      await page.goto(`${mock.url}/wall`);
      await page.click('[data-schedules] summary', 'Scheduled (1)');
      await page.until('the schedule', () => !!document.querySelector('[data-schedule="weekly-dependency-bump"]'));
      const fit = await page.eval(() => {
        const row = document.querySelector('[data-schedule="weekly-dependency-bump"]')!.getBoundingClientRect();
        const buttons = [...document.querySelectorAll('[data-schedule="weekly-dependency-bump"] button')].map((b) => b.getBoundingClientRect());
        return { scroll: document.documentElement.scrollWidth <= innerWidth, row: row.left >= 0 && row.right <= innerWidth, buttons: buttons.every((b) => b.left >= 0 && b.right <= innerWidth) };
      });
      assert.deepEqual(fit, { scroll: true, row: true, buttons: true });
      assert.match(await page.eval(() => document.querySelector('[data-schedule="weekly-dependency-bump"]')!.textContent), /on main · Mondays at 07:30/);
      await page.eval(() => document.querySelector('[data-schedules]')!.scrollIntoView({ block: 'center' }));
      await shot('wall-scheduled-narrow');
    },
  },
  {
    name: "L1 Later keeps messages written while Claude works on the task's Overview: Enter keeps one, the card counts them; the ones set to Send when it's my turn go out as one message at the end of the turn, a reply after that end holds them back, and Send now sends one held with its Undo",
    clock: 'fast',
    async run({ holds, page, mock, shot }) {
      type Snap = { sessions: { id: string; parked: { id: string; text: string; auto: boolean }[]; answered: { text: string } | null }[] };
      const invoice = async () => ((await mock.get('/api/state')) as Snap).sessions.find((s) => s.id === 's-invoice')!;
      const until = async (what: string, ok: (s: Awaited<ReturnType<typeof invoice>>) => boolean) => {
        for (const end = Date.now() + 8000; Date.now() < end; await sleep(100)) if (ok(await invoice())) return invoice();
        throw new Error(`timed out waiting for ${what}: ${JSON.stringify(await invoice())}`);
      };
      const kept = (id: string, text: string) => ({ id, text, auto: false, armedAt: null, at: Date.now() });
      await mock.post('/mock/patch', { id: 's-cart', patch: { parked: [kept('k1', 'One'), kept('k2', 'Two')] } });
      await openQueue(page, mock);
      assert.equal(await page.eval(() => document.querySelector('[data-card][data-session="s-cart"] [data-later-count]')?.textContent), 'Later 2');
      await page.click('[data-card][data-session="s-cart"] [data-later-count]');
      await page.until("s-cart's drafts on its Overview", () => document.querySelectorAll('#task-sheet [data-later] li[data-parked]').length === 2);

      await mock.post('/mock/patch', { id: 's-invoice', patch: { status: 'working', lastTurn: 't-later', summary: null, answered: null, activity: { step: 'Bash: pnpm test', since: Date.now() } } });
      await openSheetOf(page, mock, 's-invoice');
      await page.until('the Later box', () => !!document.querySelector('#task-sheet [data-later] textarea'));
      const drafts = () => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-later] li[data-parked]')]
        .map((li) => [li.querySelector('p')?.textContent, li.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked]);

      await page.click('#task-sheet [data-later] textarea[aria-label="A message for later"]');
      await page.type('Also check the credit notes.');
      await page.key('Enter');
      await page.until('the first draft', () => document.querySelectorAll('#task-sheet [data-later] li[data-parked]').length === 1);
      await page.click('#task-sheet [data-later] li[data-parked] input[type="checkbox"]');
      await page.click('#task-sheet [data-later] > div label input[type="checkbox"]');
      await page.click('#task-sheet [data-later] textarea[aria-label="A message for later"]');
      await page.type('Then rename the helper.');
      await page.key('Enter');
      await page.until('the second draft', () => document.querySelectorAll('#task-sheet [data-later] li[data-parked]').length === 2);
      await page.click('#task-sheet [data-later] > div label input[type="checkbox"]');
      await page.click('#task-sheet [data-later] textarea[aria-label="A message for later"]');
      await page.type('Kept for a press.');
      await page.key('Enter');
      await page.until('three drafts, two set to go', (want: string) => JSON.stringify([...document.querySelectorAll<HTMLElement>('#task-sheet [data-later] li[data-parked]')]
        .map((li) => [li.querySelector('p')?.textContent, li.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked])) === want,
      JSON.stringify([['Also check the credit notes.', true], ['Then rename the helper.', true], ['Kept for a press.', false]]));
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-later] h3')!.textContent), 'Later · 3 drafts');
      assert.equal((await invoice()).answered, null, 'nothing reached Claude while it works');
      await shot('later-drafts');

      await mock.post('/mock/patch', { id: 's-invoice', patch: { status: 'idle', activity: null, summary: { text: 'Fixed', basis: 't-later', at: Date.now(), question: null, decision: null } } });
      const sent = await until('the armed drafts sent', (s) => s.parked.length === 1);
      assert.equal(sent.answered?.text, 'Also check the credit notes.\n\nThen rename the helper.');
      await page.until('one draft left', () => document.querySelectorAll('#task-sheet [data-later] li[data-parked]').length === 1);
      assert.deepEqual(await page.eval(drafts), [['Kept for a press.', false]]);

      await until('Claude at work on them', (s) => (s as unknown as { status: string }).status === 'working');
      await page.click('#task-sheet [data-later] li[data-parked] input[type="checkbox"]');
      await until('the last one armed', (s) => s.parked[0].auto);
      await mock.post('/mock/patch', { id: 's-invoice', patch: { status: 'idle', activity: null, lastTurn: 't-later-2', answered: { key: null, text: 'Typed on the card', at: Date.now() + 60_000 }, summary: { text: 'Fixed', basis: 't-later-2', at: Date.now(), question: null, decision: null } } });
      await holds('a reply after the end to hold the draft back', 6000, async () => matches((await invoice()).parked.map((p) => p.text), ['Kept for a press.']));

      await page.click('#task-sheet [data-later] li[data-parked] button', 'Send now');
      await page.until('the draft out of the list while held', () => !document.querySelector('#task-sheet [data-later] li[data-parked]'));
      await page.until('the hold toast', () => [...document.querySelectorAll('[role="status"], [data-toast]')].some((t) => t.textContent?.includes('Kept for a press.')));
      const pressed = await until('the pressed draft sent', (s) => s.parked.length === 0);
      assert.equal(pressed.answered?.text, 'Kept for a press.');
      const posted = (await mock.log()).findLast((e) => e.action === 'answer' && e.sessionId === 's-invoice')!;
      assert.deepEqual((posted.body as { drafts: string[] }).drafts.length, 1);
    },
  },
  {
    name: "A1 Ask on the side, the other button of the Later box: a question while Claude works is answered by a copy of the conversation, showing what it reads, and the task's Claude gets nothing; a follow-up goes to the same copy, Keep as a draft puts the answer under Later, and Close forgets it",
    async run({ page, mock, shot }) {
      type Snap = { sessions: { id: string; answered: unknown; parked: { text: string }[]; asides: { fork: string | null; state: string; turns: { question: string; answer: string | null }[] }[] }[] };
      const invoice = async () => ((await mock.get('/api/state')) as Snap).sessions.find((s) => s.id === 's-invoice')!;
      await mock.post('/mock/patch', { id: 's-invoice', patch: { status: 'working', answered: null, activity: { step: 'Bash: pnpm test', since: Date.now() } } });
      await openSheetOf(page, mock, 's-invoice');
      await page.click('#task-sheet [data-later] textarea[aria-label="A message for later"]');
      await page.type('Why integer cents?');
      await page.click('#task-sheet [data-later] button', 'Ask on the side');
      await page.until('the box emptied', () => document.querySelector<HTMLTextAreaElement>('#task-sheet [data-later] textarea[aria-label="A message for later"]')!.value === '');
      assert.equal(await page.eval(() => document.querySelectorAll('#task-sheet [data-later] li[data-parked]').length), 0, 'asking keeps no draft');
      await page.until('the copy reading', () => document.querySelector('#task-sheet [data-aside][data-state="thinking"]')?.textContent?.includes('Read: src/invoice/LineItem.ts'));
      await page.until('the answer', () => !!document.querySelector('#task-sheet [data-aside][data-state="done"] strong'));
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-aside] p')!.textContent), 'Why integer cents?');
      await shot('aside-answered');

      await page.click('#task-sheet [data-aside] textarea[aria-label="A follow-up question"]');
      await page.type('And for refunds?');
      await page.key('Enter');
      await page.until('the follow-up answered', () => document.querySelectorAll('#task-sheet [data-aside][data-state="done"] strong').length === 2);
      const one = (await invoice()).asides[0];
      assert.match(one.fork ?? '', /^fork-\d+$/);
      assert.deepEqual(one.turns.map((t) => t.question), ['Why integer cents?', 'And for refunds?'], 'the follow-up went to the same copy');

      await page.click('#task-sheet [data-aside] button', 'Keep as a draft');
      await page.until('the answer under Later', () => document.querySelector('#task-sheet [data-later] li[data-parked] p')?.textContent?.startsWith('On the side: **And for refunds?**'));
      await page.click('#task-sheet [data-aside] button', 'Close');
      await page.until('the aside gone', () => !document.querySelector('#task-sheet [data-aside]'));
      const after = await invoice();
      assert.deepEqual([after.asides, after.answered], [[], null], "nothing reached the task's Claude");
      assert.equal((await mock.log()).filter((e) => e.sessionId === 's-invoice' && e.action === 'answer').length, 0);
    },
  },
  {
    name: "L5 while Claude shows a question in its terminal, Send now on a draft under Later is off and says to answer or decline the question first, as the send would be refused; once it is answered Send now is on again, and a question that opens during the hold calls the send off with a toast that says the draft is still under Later, where it is",
    async run({ page, mock }) {
      type Snap = { sessions: { id: string; parked: { id: string }[]; answered: { text: string } | null }[] };
      const hooks = async () => ((await mock.get('/api/state')) as Snap).sessions.find((s) => s.id === 's-hooks')!;
      const { menu } = await stateOf(mock, 's-hooks');
      await mock.post('/mock/patch', { id: 's-hooks', patch: { parked: [{ id: 'k1', text: 'Skip that, first look at the retries table.', auto: false, armedAt: null, at: Date.now() }] } });
      await openSheetOf(page, mock, 's-hooks');
      const sendNow = () => {
        const b = [...document.querySelectorAll<HTMLButtonElement>('#task-sheet [data-later] li[data-parked] button')].find((e) => e.textContent === 'Send now');
        return b ? { disabled: b.disabled, does: b.dataset.explain!.split('\n\n')[0] } : null;
      };
      const off = await page.until('the draft under Later', sendNow);
      assert.deepEqual(off, { disabled: true, does: 'Claude is showing a question in its terminal, which a message would answer by accident: answer or decline it first. The draft waits here.' });

      await mock.post('/mock/patch', { id: 's-hooks', patch: { status: 'idle', menu: null, waitingFor: null } });
      await page.until('Send now on again', () => [...document.querySelectorAll<HTMLButtonElement>('#task-sheet [data-later] li[data-parked] button')].some((b) => b.textContent === 'Send now' && !b.disabled));
      await page.click('#task-sheet [data-later] li[data-parked] button', 'Send now');
      await page.until('the draft out of the list while held', () => !document.querySelector('#task-sheet [data-later] li[data-parked]'));
      await mock.post('/mock/patch', { id: 's-hooks', patch: { status: 'waiting', menu: { ...menu, toolUseId: 'toolu_03Hooks', at: Date.now() } } });
      await sleep(3000);
      await page.until('the refusal saying where the draft is', () => [...document.querySelectorAll('[data-toast]')]
        .some((t) => t.textContent?.startsWith('Not sent to Retry failed webhooks:') && t.textContent.includes('The draft is still under Later.')));
      await page.until('the draft back under Later', () => document.querySelector('#task-sheet [data-later] li[data-parked] p')?.textContent === 'Skip that, first look at the retries table.');
      const after = await hooks();
      assert.equal(after.parked.length, 1, 'the draft stays on the task');
      assert.equal(after.answered, null, 'nothing reached Claude');
    },
  },
  {
    name: "L6 Decline on a question Claude shows in its terminal presses Esc there after its 5 s Undo; once it is gone Send now under Later is on again with no reload and sends the draft",
    async run({ page, mock }) {
      type Snap = { sessions: { id: string; status: string; menu: unknown; parked: { id: string }[]; answered: { text: string } | null }[] };
      const hooks = async () => ((await mock.get('/api/state')) as Snap).sessions.find((s) => s.id === 's-hooks')!;
      const draft = 'Skip that, first look at the retries table.';
      await mock.post('/mock/patch', { id: 's-hooks', patch: { parked: [{ id: 'k1', text: draft, auto: false, armedAt: null, at: Date.now() }] } });
      await openSheetOf(page, mock, 's-hooks');
      const sendNowOn = () => [...document.querySelectorAll<HTMLButtonElement>('#task-sheet [data-later] li[data-parked] button')].some((b) => b.textContent === 'Send now' && !b.disabled);
      await page.until('the draft under Later', () => !!document.querySelector('#task-sheet [data-later] li[data-parked]'));
      assert.equal(await page.eval(sendNowOn), false, 'Send now is off while the question is open');

      await page.click('#task-sheet [data-queued] button', 'Decline');
      await page.until('the hold toast', () => [...document.querySelectorAll('[data-toast]')].some((t) => t.textContent?.startsWith('Declining “Which retry schedule')));
      await sleep(3000);
      await page.until('Send now on again once the question is gone', sendNowOn);
      assert.equal(await page.eval(() => !!document.querySelector('#task-sheet [data-queued]')), false, 'the question left the page');
      const declined = (await mock.log()).filter((e) => e.sessionId === 's-hooks' && e.action === 'decline-menu');
      assert.deepEqual(declined.map((e) => e.body), [{ toolUseId: 'toolu_01Hooks' }]);
      const after = await hooks();
      assert.deepEqual([after.status, after.menu, after.answered?.text], ['idle', null, 'Declined the question']);

      await page.click('#task-sheet [data-later] li[data-parked] button', 'Send now');
      for (const end = Date.now() + 9000; Date.now() < end && (await hooks()).parked.length; ) await sleep(200);
      const sent = await hooks();
      assert.equal(sent.parked.length, 0, 'the draft went out');
      assert.equal(sent.answered?.text, draft);
    },
  },
  {
    name: "L2 tooltips: every action in Later explains itself, in three parts, what it does, what the Claude it reaches has in its context and whether that is the task's own session or a separate fork; one translucent tooltip shows any element's explanation on hover, also on a disabled button, and on keyboard focus, above the element or below it with no room, inside the window and over the task page, and goes on Escape",
    async run({ page, mock, shot }) {
      await mock.post('/mock/patch', { id: 's-invoice', patch: { status: 'working', parked: [{ id: 'k1', text: 'Also the credit notes.', auto: false, armedAt: null, at: Date.now() }] } });
      await openSheetOf(page, mock, 's-invoice');
      await page.until('the Later box', () => !!document.querySelector('#task-sheet [data-later] li[data-parked]'));
      const tips = await page.eval(() => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-later] [data-explain]')]
        .map((e) => [e.textContent.trim(), e.dataset.explain!.split('\n\n').map((l) => l.split(':')[0])]));
      const byName = Object.fromEntries(tips as [string, string[]][]);
      assert.deepEqual(byName['Send now'], ['Sends this draft as your next message, with 5 s to undo. While Claude works it reads it at its next step, which can change what it is doing.', 'What Claude has', 'Session']);
      assert.deepEqual(byName['Keep for later ↵'].slice(1), ['What Claude has', 'Session']);
      assert.ok(byName['Ask on the side'], 'Ask on the side explains itself');
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll('[title]:not(svg *)')].map((e) => e.outerHTML.slice(0, 160))), [], 'no native tooltip is left');
      const tip = () => {
        const t = document.getElementById('tooltip');
        if (!t?.matches(':popover-open')) return null;
        const r = t.getBoundingClientRect();
        return { text: t.textContent, side: t.dataset.side, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, bottom: Math.round(r.bottom), alpha: getComputedStyle(t).backgroundColor };
      };
      assert.equal(await page.eval(tip), null, 'none until hovered');
      await page.hover('#task-sheet [data-later] li[data-parked] button', 'Send now');
      const shown = await page.until('the tip of Send now', tip);
      assert.match(shown.text, /^Sends this draft as your next message[^]*What Claude has: the whole conversation[^]*Session: the task's own session/);
      assert.deepEqual([shown.side, shown.inside], ['above', true]);
      const button = await page.eval(() => Math.round([...document.querySelectorAll<HTMLElement>('#task-sheet [data-later] li[data-parked] button')].find((b) => b.textContent === 'Send now')!.getBoundingClientRect().top));
      assert.ok(shown.bottom <= button, 'above the button, not over it');
      assert.match(shown.alpha, /oklab\(.* \/ 0\.\d+\)|rgba\(.*, 0\.\d+\)/, `translucent: ${shown.alpha}`);
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-later] li[data-parked] button[aria-describedby="tooltip"]')?.textContent ?? null), null, 'its own description is enough');
      await shot('later-tip');
      await page.key('Escape');
      await page.until('gone on Escape', () => !document.getElementById('tooltip')?.matches(':popover-open'));
      assert.equal(await page.eval(sheetOpen), true, 'that Escape only took the tooltip away');

      await page.hover('#task-sheet [data-later] button', 'Ask on the side');
      assert.match((await page.until('a disabled button explains itself too', tip)).text, /^Asks the text as a question/);

      await page.hover('#task-sheet [data-explain="Claude Code\'s session id; claude --resume takes it"]');
      const plain = await page.until('a plain title as a tooltip', tip);
      assert.equal(plain.text, "Claude Code's session id; claude --resume takes it");
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [aria-describedby="tooltip"]')?.getAttribute('data-explain') ?? null), "Claude Code's session id; claude --resume takes it", 'described by the tooltip while it shows');

      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.eval(() => document.querySelector<HTMLElement>('#task-sheet [data-later] li[data-parked] button')!.focus());
      await page.key('Tab');
      await page.until('a tip on keyboard focus', () => document.getElementById('tooltip')?.matches(':popover-open') && document.getElementById('tooltip')!.textContent.startsWith('Changes the draft'));

      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      await page.hover('[data-explain]:is(header *, nav *)');
      const top = await page.until('a tip in the top bar', tip);
      assert.deepEqual([top.side, top.inside], ['below', true], 'below when there is no room above');
    },
  },
  {
    name: 'L3 every button and link on the queue, the Wall and a task page has a name of its own, so moving the hover hints into tooltips took none away',
    async run({ page, mock }) {
      const unnamed = () => [...document.querySelectorAll<HTMLElement>('button, a[href], [role="button"], [role="tab"], summary')]
        .filter((e) => e.checkVisibility() && !e.closest('[inert], [aria-hidden="true"]'))
        .filter((e) => !(e.getAttribute('aria-label')?.trim() || e.getAttribute('aria-labelledby') || e.innerText.trim() || e.querySelector('img[alt]:not([alt=""])')))
        .map((e) => e.outerHTML.slice(0, 200));
      await openQueue(page, mock);
      assert.deepEqual(await page.eval(unnamed), [], 'the queue');
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      assert.deepEqual(await page.eval(unnamed), [], 'the Wall');
      await openSheetOf(page, mock, 's-invoice');
      assert.deepEqual(await page.eval(unnamed), [], 'a task page');
    },
  },
  {
    name: "L4 the other actions that send text to a Claude say in three parts what they do, what that Claude has in its context and which session it is: a finding's answers start a subtask that has not seen the review, Elaborate is a one-off run, and Continue the turn says what it sends",
    scenario: 'findings',
    async run({ page, mock }) {
      const parts = (sel: string) => document.querySelector<HTMLElement>(sel)?.dataset.explain?.split('\n\n') ?? null;
      await page.goto(`${mock.url}/s/s-review`);
      await page.until('the findings', () => !!document.querySelector('#task-sheet [data-response="accept"]'));
      const accept = (await page.eval(parts, '#task-sheet [data-response="accept"]'))!;
      assert.equal(accept.length, 3);
      assert.match(accept[1], /^What Claude has: .*nothing of the review's conversation$/);
      assert.match(accept[2], /^Session: a new session of its own, a subtask in this same worktree/);
      for (const kind of ['elaborate', 'second-look', 'reply']) assert.equal((await page.eval(parts, `#task-sheet [data-response="${kind}"]`))?.length, 3, kind);
      assert.match(await page.eval(() => document.querySelector('#task-sheet [data-response="accept"]')!.getAttribute('aria-description') ?? ''), /^Starts a new Claude/);
      await mock.post('/mock/patch', { id: 's-review', patch: { status: 'idle', interrupted: { at: Date.now() - 60_000, status: 'working', waitingFor: null, menu: null } } });
      await page.until('Continue the turn', () => [...document.querySelectorAll('#task-sheet button')].some((b) => b.textContent === 'Continue the turn'));
      const cont = await page.eval(() => [...document.querySelectorAll<HTMLElement>('#task-sheet button')].find((b) => b.textContent === 'Continue the turn')!.dataset.explain!.split('\n\n'));
      assert.deepEqual(cont.map((p) => p.split(':')[0]), ['Sends Claude, with 5 s to undo', 'What Claude has', 'Session']);
      assert.match(cont[0], /“The Mac restarted while you were working/);
    },
  },
];
