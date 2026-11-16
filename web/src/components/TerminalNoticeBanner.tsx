import { api } from '../api.ts';
import { useStore } from '../store.ts';
import type { TerminalNotice } from '../types.ts';
import { tilde } from '../util.ts';
import styles from './RestartBanner.module.css';

const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// Ghostty refuses to be asked which tabs it has without the Automation permission, so the tabs are named by where
// they were: the removed directory and the ttys the task's Claudes ran on.
function Notice({ notice, home }: { notice: TerminalNotice; home: string }) {
  const where = [...(notice.dir ? [`in ${tilde(notice.dir, home)}`] : []), ...(notice.ttys.length ? [`on ${list(notice.ttys)}`] : [])];
  const dismiss = () => void api('POST', `/api/terminal-notices/${notice.id}/dismiss`).catch(reportError);
  return (
    <section className={styles.banner} data-terminal-notice aria-live="polite">
      <p>
        <strong>Ghostty did not let Pitwall close the tabs of {list(notice.tasks)}</strong>: the task is cleared, and any tab {list(where)} is still open.
        {' '}
        {notice.permission
          ? 'To let Pitwall close them, turn on Ghostty under node in System Settings → Privacy & Security → Automation.'
          : `Ghostty answered: ${notice.error}`}
      </p>
      <button type="button" data-dismiss-terminal-notice onClick={dismiss}>Dismiss</button>
    </section>
  );
}

export function TerminalNoticeBanner() {
  const { terminalNotices, home } = useStore();
  return terminalNotices.map((n) => <Notice key={n.id} notice={n} home={home} />);
}
