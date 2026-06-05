/**
 * sync.ts — the bridge between the agent-facing domain model and tldraw.
 *
 *   domain JSON  ──applyCanvasToEditor──►  tldraw shapes (what you see)
 *   tldraw edits ──readCanvasFromEditor──►  domain JSON  (saved back via WS)
 *
 * The agent never sees tldraw's internal records. We translate:
 *   - a company node  -> a custom 'company' shape
 *   - a group         -> a 'frame' shape (titled container); members are parented to it
 *   - an edge         -> an 'arrow' shape with two bindings so it follows the nodes
 *
 * Every shape we manage carries meta.{domainId,kind} so we can round-trip
 * reliably without parsing shape ids.
 */
import {
  createBindingId,
  createShapeId,
  toRichText,
  type Editor,
  type TLShapeId,
} from 'tldraw';

// ---- domain types ----------------------------------------------------------
export type DomainNode = {
  id: string; type: 'company'; name: string; subtitle?: string;
  x: number; y: number; w: number; h: number; color?: string;
  logoUrl?: string | null; groupId?: string | null;
  metadata?: unknown; sources?: { label: string; url: string }[];
};
export type DomainEdge = { id: string; from: string; to: string; label?: string };
export type DomainGroup = { id: string; label: string; x: number; y: number; w: number; h: number };
export type Canvas = { version?: number; title?: string; nodes: DomainNode[]; edges: DomainEdge[]; groups: DomainGroup[] };

// ---- id helpers (deterministic, bidirectional via meta.domainId) -----------
const nodeShapeId = (id: string) => createShapeId(id);
const frameShapeId = (id: string) => createShapeId(`group_${id}`);
const edgeShapeId = (id: string) => createShapeId(`edge_${id}`);

const round = (n: number) => Math.round(n);

// Guard so changes WE apply don't get re-sent as if the human made them.
let applyingRemote = false;
export const isApplyingRemote = () => applyingRemote;

// ============================================================================
// domain  ->  tldraw
// ============================================================================
export function applyCanvasToEditor(editor: Editor, canvas: Canvas) {
  applyingRemote = true;
  try {
    // mergeRemoteChanges tags these mutations source:'remote', so the human
    // listener (source:'user') never fires for them — no feedback loop.
    editor.store.mergeRemoteChanges(() => {
      editor.run(
        () => {
          const groupsById: Record<string, DomainGroup> = {};
          for (const g of canvas.groups) groupsById[g.id] = g;

          const desired = new Set<TLShapeId>();
          for (const g of canvas.groups) desired.add(frameShapeId(g.id));
          for (const n of canvas.nodes) desired.add(nodeShapeId(n.id));

          // 1. Delete managed shapes no longer wanted. Edges are always rebuilt.
          const toDelete: TLShapeId[] = [];
          for (const s of editor.getCurrentPageShapes()) {
            const kind = (s.meta as { kind?: string } | undefined)?.kind;
            if (kind === 'edge') toDelete.push(s.id);
            else if ((kind === 'company' || kind === 'group') && !desired.has(s.id)) toDelete.push(s.id);
          }
          if (toDelete.length) editor.deleteShapes(toDelete);

          // 2. Frames first (must exist before children are parented to them).
          for (const g of canvas.groups) upsertFrame(editor, g);
          // 3. Company nodes.
          for (const n of canvas.nodes) upsertCompany(editor, n, groupsById);
          // 4. Edges (arrows + bindings) recreated fresh each time.
          for (const e of canvas.edges) createEdge(editor, e);
        },
        { history: 'ignore' }
      );
    });
  } finally {
    applyingRemote = false;
  }
}

function upsertFrame(editor: Editor, g: DomainGroup) {
  const id = frameShapeId(g.id);
  const partial = {
    id,
    type: 'frame' as const,
    x: g.x,
    y: g.y,
    props: { w: g.w, h: g.h, name: g.label },
    meta: { domainId: g.id, kind: 'group' },
  };
  if (editor.getShape(id)) editor.updateShape(partial);
  else editor.createShape(partial);
}

function upsertCompany(editor: Editor, n: DomainNode, groupsById: Record<string, DomainGroup>) {
  const id = nodeShapeId(n.id);
  const parentId = n.groupId ? frameShapeId(n.groupId) : editor.getCurrentPageId();
  const g = n.groupId ? groupsById[n.groupId] : null;
  // Domain coords are absolute (page space). Children of a frame use coords
  // relative to the frame's top-left.
  const x = g ? n.x - g.x : n.x;
  const y = g ? n.y - g.y : n.y;
  const props = {
    name: n.name,
    subtitle: n.subtitle ?? '',
    w: n.w,
    h: n.h,
    color: n.color ?? 'blue',
    logoUrl: n.logoUrl ?? null,
    metadata: n.metadata ?? {},
    sources: n.sources ?? [],
  };
  const meta = { domainId: n.id, kind: 'company' };
  const existing = editor.getShape(id);
  if (!existing) {
    editor.createShape({ id, type: 'company', parentId, x, y, props, meta });
  } else {
    if (existing.parentId !== parentId) editor.reparentShapes([id], parentId);
    editor.updateShape({ id, type: 'company', x, y, props, meta });
  }
}

function createEdge(editor: Editor, e: DomainEdge) {
  const fromId = nodeShapeId(e.from);
  const toId = nodeShapeId(e.to);
  if (!editor.getShape(fromId) || !editor.getShape(toId)) return; // endpoints missing
  const id = edgeShapeId(e.id);
  editor.createShape({
    id,
    type: 'arrow',
    props: { richText: toRichText(e.label ?? '') },
    meta: { domainId: e.id, kind: 'edge', label: e.label ?? '' },
  });
  editor.createBinding({
    id: createBindingId(),
    type: 'arrow',
    fromId: id,
    toId: fromId,
    props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
  });
  editor.createBinding({
    id: createBindingId(),
    type: 'arrow',
    fromId: id,
    toId: toId,
    props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
  });
}

// ============================================================================
// tldraw  ->  domain
// ============================================================================
export function readCanvasFromEditor(editor: Editor, base?: Canvas): Canvas {
  const nodes: DomainNode[] = [];
  const groups: DomainGroup[] = [];
  const edges: DomainEdge[] = [];

  for (const s of editor.getCurrentPageShapes()) {
    const m = s.meta as { domainId?: string; kind?: string; label?: string } | undefined;
    if (!m?.domainId) continue;

    if (m.kind === 'company') {
      const b = editor.getShapePageBounds(s.id);
      if (!b) continue;
      const p = (s as { props: Record<string, unknown> }).props;
      nodes.push({
        id: m.domainId,
        type: 'company',
        name: String(p.name ?? ''),
        subtitle: String(p.subtitle ?? ''),
        x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h),
        color: String(p.color ?? 'blue'),
        logoUrl: (p.logoUrl as string | null) ?? null,
        groupId: groupIdOfParent(editor, s.parentId),
        metadata: p.metadata ?? {},
        sources: (p.sources as { label: string; url: string }[]) ?? [],
      });
    } else if (m.kind === 'group') {
      const b = editor.getShapePageBounds(s.id);
      if (!b) continue;
      const p = (s as { props: Record<string, unknown> }).props;
      groups.push({ id: m.domainId, label: String(p.name ?? ''), x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) });
    } else if (m.kind === 'edge') {
      let from: string | undefined;
      let to: string | undefined;
      for (const binding of editor.getBindingsFromShape(s.id, 'arrow')) {
        const target = editor.getShape(binding.toId);
        const domId = (target?.meta as { domainId?: string } | undefined)?.domainId;
        const terminal = (binding.props as { terminal?: string }).terminal;
        if (terminal === 'start') from = domId;
        else if (terminal === 'end') to = domId;
      }
      if (from && to) edges.push({ id: m.domainId, from, to, label: m.label ?? '' });
    }
  }

  return { version: base?.version ?? 1, title: base?.title ?? 'Untitled map', nodes, edges, groups };
}

function groupIdOfParent(editor: Editor, parentId: TLShapeId | string): string | null {
  const parent = editor.getShape(parentId as TLShapeId);
  const m = parent?.meta as { kind?: string; domainId?: string } | undefined;
  return m?.kind === 'group' ? m.domainId ?? null : null;
}

// ============================================================================
// live transport (WebSocket to the hub)
// ============================================================================
export type CanvasInfo = { id: string; title: string; nodes: number; edges: number; groups: number };

export function startSync(
  editor: Editor,
  opts: {
    url: string;
    onStatus?: (s: 'connected' | 'disconnected') => void;
    onList?: (canvases: CanvasInfo[]) => void;
    onActive?: (activeId: string | null, title: string) => void;
  } = { url: 'ws://localhost:5174/ws' }
) {
  let ws: WebSocket | null = null;
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCanvas: Canvas | undefined;
  let currentActiveId: string | null = null;

  function scheduleSend() {
    if (applyingRemote) return;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const canvas = readCanvasFromEditor(editor, lastCanvas);
      lastCanvas = canvas;
      ws.send(JSON.stringify({ type: 'human-update', canvas }));
    }, 250);
  }

  // Only fires for human ("user") document edits, never for our remote applies.
  const unlisten = editor.store.listen(scheduleSend, { source: 'user', scope: 'document' });

  function connect() {
    ws = new WebSocket(opts.url);
    ws.onopen = () => opts.onStatus?.('connected');
    ws.onclose = () => {
      opts.onStatus?.('disconnected');
      setTimeout(connect, 1000); // resilient reconnect for a long-lived session
    };
    ws.onerror = () => ws?.close();
    ws.onmessage = (ev) => {
      let msg: { type: string; canvas?: Canvas; activeId?: string | null; canvases?: CanvasInfo[] };
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'canvases' && msg.canvases) {
        opts.onList?.(msg.canvases);
        return;
      }
      if (msg.type === 'canvas' && msg.canvas) {
        const switched = (msg.activeId ?? null) !== currentActiveId;
        currentActiveId = msg.activeId ?? null;
        lastCanvas = msg.canvas;
        applyCanvasToEditor(editor, msg.canvas);
        opts.onActive?.(currentActiveId, msg.canvas.title ?? '');
        // Fit the view on first load and whenever we switch to a different map.
        if (switched) requestAnimationFrame(() => editor.zoomToFit());
      }
    };
  }
  connect();

  return () => {
    unlisten();
    clearTimeout(sendTimer);
    ws?.close();
  };
}
