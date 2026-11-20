import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { api, sessionAction } from '../api.ts';
import { changeCount, describeChanges, diagramsOf, markChanges } from '../architecture.ts';
import { showDiagram, showTab, type View } from '../router.ts';
import { useStore } from '../store.ts';
import { useDark } from '../theme.ts';
import type { ArchitectureChanges, ArchitectureView, ElementChange, ModelError, RelationChange, Session } from '../types.ts';
import { tilde } from '../util.ts';
import styles from './Architecture.module.css';
import { toast, UNDO_KBD } from './Toasts.tsx';

const Canvas = lazy(() => import('./ArchitectureCanvas.tsx'));

type Read = { view: ArchitectureView } | { error: string };

const reportError = (err: unknown) => toast('error', err instanceof Error ? err.message : String(err));

// The diagrams above `view` that lead down to it: the overview, then the diagram of each element it lies in.
function trail(diagrams: { id: string; title: string; of: string | null }[], view: string) {
  const shown = diagrams.find((d) => d.id === view);
  if (!shown?.of) return [];
  const parts = shown.of.split('.');
  const above = parts.slice(0, -1).map((_, i) => diagrams.find((d) => d.of === parts.slice(0, i + 1).join('.'))).filter((d) => !!d);
  const index = diagrams.find((d) => d.id === 'index');
  return [...(index && index.id !== view ? [index] : []), ...above];
}

// The task's architecture model, drawn by LikeC4 on an interactive canvas: pan, zoom, an element's details on a
// click, into a diagram of an element and back. Read again whenever the model's files or the project's change.
export function Architecture({ session, item, view }: { session: Session; item: string | null; view: View }) {
  const { home } = useStore();
  const dark = useDark();
  const models = session.architecture?.models ?? [];
  const model = models.find((m) => m.key === item) ?? models[0];
  const [read, setRead] = useState<Read | null>(null);
  const [keeping, setKeeping] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  const key = model?.key ?? null;
  const stamp = model?.stamp ?? null;
  const standing = model?.standing ?? null;
  useEffect(() => {
    if (key === null || stamp === null) return;
    let live = true;
    api('GET', `/api/sessions/${session.id}/architecture?model=${encodeURIComponent(key)}`).then(
      (v) => live && setRead({ view: v }),
      (err: Error) => live && setRead({ error: err.message }),
    );
    return () => {
      live = false;
    };
  }, [session.id, key, stamp, standing]);

  const shown = read && 'view' in read && read.view.key === key ? read.view : null;
  const changes = shown?.changes ?? null;
  const showChanges = !!view.changes && !!changes;
  const data = useMemo(() => (shown?.model && changes && showChanges ? markChanges(shown.model, changes) : shown?.model ?? null), [shown, changes, showChanges]);
  const diagrams = useMemo(() => (shown?.model ? diagramsOf(shown.model) : []), [shown]);
  const diagram = diagrams.find((d) => d.id === view.diagram) ?? diagrams[0];
  const differs = !!shown && !shown.main && shown.standing?.stamp !== shown.stamp;
  const canKeep = differs && !shown.errors.length && model?.stamp === shown.stamp;

  if (!model) return <p className={styles.empty}>This task has no architecture model.</p>;
  const itemOf = (k: string) => (models.length > 1 || k ? k : null);
  const go = (to: string) => showDiagram(itemOf(model.key), { diagram: to, changes: showChanges || undefined });
  const toggle = () => showTab('architecture', itemOf(model.key), { diagram: diagram?.id, changes: !showChanges || undefined });

  const keep = async () => {
    dialog.current?.close();
    if (!shown) return;
    setKeeping(true);
    try {
      const { undo } = await sessionAction(session.id, 'keep-architecture', { model: shown.key, stamp: shown.stamp });
      toast('undo', `Kept as ${shown.name}'s architecture`, {
        session: session.id,
        action: { label: 'Undo', kbd: UNDO_KBD, run: () => void sessionAction(session.id, 'restore-architecture', { undo }).catch(reportError) },
      });
    } catch (err) {
      reportError(err);
    } finally {
      setKeeping(false);
    }
  };

  return (
    <div className={styles.page} data-architecture={model.key || model.name}>
      <div className={styles.bar}>
        {models.length > 1 && (
          <nav className={styles.models} aria-label="Repositories">
            {models.map((m) => (
              <button key={m.key} type="button" aria-current={m === model} onClick={() => showTab('architecture', m.key)}>{m.name}</button>
            ))}
          </nav>
        )}
        {diagram && (
          <nav className={styles.trail} aria-label="Diagram">
            {trail(diagrams, diagram.id).map((d) => (
              <span key={d.id}><button type="button" data-diagram-up={d.id} onClick={() => go(d.id)}>{d.title}</button> ›</span>
            ))}
            <select aria-label="Diagram" data-diagram-picker value={diagram.id} onChange={(e) => go(e.target.value)}>
              {diagrams.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
            </select>
          </nav>
        )}
        {changes && (
          <label className={styles.toggle} data-explain="Marks what this task's model adds (green) and changes (amber) against the project's architecture, and lists it with what it removes">
            <input type="checkbox" data-changes-toggle checked={showChanges} onChange={toggle} />
            This task's changes{changeCount(changes) ? ` (${changeCount(changes)})` : ''}
          </label>
        )}
        {differs && (
          <button
            type="button"
            className={styles.keep}
            data-keep
            disabled={!canKeep || keeping}
            data-explain={shown.errors.length ? 'The model has errors; it can be kept once it has none.' : `Copies this task's model over the project's standing one in ${tilde(shown.mainCheckout ?? '', home)}`}
            onClick={() => dialog.current?.showModal()}
          >
            Keep as the project's architecture…
          </button>
        )}
      </div>
      <div className={styles.body}>
        {!read ? (
          <p className={styles.empty}>Laying out the model…</p>
        ) : 'error' in read ? (
          <p className={styles.empty}>Could not read the model: {read.error}</p>
        ) : shown && shown.errors.length ? (
          <Errors errors={shown.errors} />
        ) : data && diagram ? (
          <div className={styles.canvas} data-canvas>
            <Suspense fallback={<p className={styles.empty}>Loading the canvas…</p>}>
              <Canvas data={data} view={diagram.id} dark={dark} onNavigate={go} />
            </Suspense>
          </div>
        ) : (
          <p className={styles.empty}>The model has no diagrams.</p>
        )}
        {showChanges && changes && <ChangeList changes={changes} />}
      </div>
      <dialog ref={dialog} id="keep-architecture" role="alertdialog" aria-labelledby="keep-architecture-title" className={styles.dialog}>
        {shown && (
          <>
            <h2 id="keep-architecture-title">Keep this as the project's architecture?</h2>
            <code className={styles.path}>{tilde(`${shown.mainCheckout}/.pitwall/architecture`, home)}</code>
            <p>
              {shown.standing
                ? <>The model in {shown.name}'s main checkout is replaced by this task's: {changes ? describeChanges(changes) : 'its files are copied over'}.</>
                : <>{shown.name}'s main checkout has no model yet; this task's becomes it, and new tasks start from it.</>}
            </p>
            <p className={styles.muted}>Only the model's .c4 files change, none of them in git. Undo puts the earlier ones back.</p>
            <footer>
              <button type="button" commandfor="keep-architecture" command="close" autoFocus>Cancel</button>
              <button type="button" data-variant="primary" data-keep-confirm onClick={() => void keep()}>Keep</button>
            </footer>
          </>
        )}
      </dialog>
    </div>
  );
}

function Errors({ errors }: { errors: ModelError[] }) {
  return (
    <div className={styles.errors} data-model-errors role="alert">
      <h3>The model does not parse, so there is nothing to draw</h3>
      <p>LikeC4 found {errors.length === 1 ? 'this error; Claude can fix it' : `these ${errors.length} errors; Claude can fix them`} with /architecture.</p>
      <ul>
        {errors.map((e) => (
          <li key={`${e.file}:${e.line}:${e.column}:${e.message}`}>
            <code>{e.file}:{e.line}:{e.column}</code>
            <span>{e.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const relationText = (r: RelationChange) => `${r.sourceTitle} → ${r.targetTitle}${r.title ? `: ${r.title}` : ''}`;

function ChangeList({ changes }: { changes: ArchitectureChanges }) {
  const groups: { kind: 'added' | 'changed' | 'removed'; label: string }[] = [
    { kind: 'added', label: 'Added' },
    { kind: 'changed', label: 'Changed' },
    { kind: 'removed', label: 'Removed' },
  ];
  const element = (e: ElementChange) => <><strong>{e.title}</strong> <span>{e.kind}{e.fields ? ` · ${e.fields.join(', ')}` : ''}</span></>;
  return (
    <aside className={styles.changes} data-change-list aria-label="This task's changes">
      {!changeCount(changes) && <p className={styles.muted}>The model is the same as the project's.</p>}
      {groups.map(({ kind, label }) => {
        const elements = changes.elements[kind];
        const relations = changes.relations[kind];
        if (!elements.length && !relations.length) return null;
        return (
          <section key={kind} data-change-kind={kind}>
            <h3>{label}</h3>
            <ul>
              {elements.map((e) => <li key={e.id} data-change-element={e.id}>{element(e)}</li>)}
              {relations.map((r) => <li key={r.key} data-change-relation={r.key}><strong>{relationText(r)}</strong>{r.fields && <span> · {r.fields.join(', ')}</span>}</li>)}
            </ul>
          </section>
        );
      })}
    </aside>
  );
}
