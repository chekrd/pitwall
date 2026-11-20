import { LikeC4Model } from 'likec4/model';
import { LikeC4ModelProvider, ReactLikeC4, type DiagramApi } from 'likec4/react';
import { useMemo, useRef, type CSSProperties } from 'react';
import type { LayoutedData } from '../types.ts';

// LikeC4's interactive canvas, in a chunk of its own that loads with the Architecture tab. It draws in its own shadow
// root, in the board's font, and loads nothing: no font of its own and no icons from its site.

const noIcon = () => null;

const size: CSSProperties = { width: '100%', height: '100%' };

// LikeC4 scopes its styles to its shadow root and sets its font variable there, out of reach of the page's styles; the
// project's custom stylesheet, which it puts in the shadow root after its own, is the way in.
const BOARD_FONT = ".likec4-shadow-root { --likec4-app-font: 'Hanken Grotesk Variable', ui-sans-serif, system-ui, sans-serif; }";

type Project = { id: string; styles?: Record<string, unknown> };

export interface CanvasProps {
  data: LayoutedData;
  view: string;
  dark: boolean;
  onNavigate: (view: string) => void;
}

export default function ArchitectureCanvas({ data, view, dark, onNavigate }: CanvasProps) {
  const model = useMemo(() => {
    const { project = { id: 'default' } } = data as LayoutedData & { project?: Project };
    return LikeC4Model.create({ ...data, project: { ...project, styles: { ...project.styles, customCss: { content: BOARD_FONT } } } } as never);
  }, [data]);
  const diagram = useRef<DiagramApi | null>(null);
  return (
    <LikeC4ModelProvider likec4model={model}>
      {/* A diagram of its own for each view: LikeC4 animates the camera from one view into the next for a while after
          the view changed, with no sign of when it ends, while a fresh one is placed at once. */}
      <ReactLikeC4
        key={view}
        viewId={view}
        colorScheme={dark ? 'dark' : 'light'}
        injectFontCss={false}
        renderIcon={noIcon}
        style={size}
        pannable
        zoomable
        fitView
        controls={false}
        background="dots"
        showNavigationButtons={false}
        enableSearch={false}
        enableFocusMode
        enableElementDetails
        enableRelationshipDetails
        enableRelationshipBrowser
        enableElementTags={false}
        enableNotations={false}
        enableCompareWithLatest={false}
        onInitialized={({ diagram: api }) => (diagram.current = api)}
        onNodeClick={(node) => {
          if (node.modelRef) diagram.current?.openElementDetails(node.modelRef, node.id);
        }}
        onNavigateTo={(to) => onNavigate(to)}
      />
    </LikeC4ModelProvider>
  );
}
