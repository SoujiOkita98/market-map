import { useCallback, useRef, useState } from 'react';
import { Tldraw, type Editor } from 'tldraw';
import 'tldraw/tldraw.css';
import { CompanyShapeUtil } from './CompanyShape';
import { startSync, type CanvasInfo } from './sync';

const HUB_WS = import.meta.env.VITE_HUB_WS ?? 'ws://localhost:5174/ws';
const HUB_HTTP = HUB_WS.replace(/^ws/, 'http').replace(/\/ws$/, '');
const customShapeUtils = [CompanyShapeUtil];

export default function App() {
  const editorRef = useRef<Editor | null>(null);
  const [status, setStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [canvases, setCanvases] = useState<CanvasInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    (window as unknown as { editor: Editor }).editor = editor;
    return startSync(editor, {
      url: HUB_WS,
      onStatus: setStatus,
      onList: setCanvases,
      onActive: (id) => setActiveId(id),
    });
  }, []);

  const switchCanvas = useCallback(async (id: string) => {
    if (id === activeId) return;
    await fetch(`${HUB_HTTP}/api/active`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    });
  }, [activeId]);

  const newCanvas = useCallback(async () => {
    const title = window.prompt('New map name?', 'Untitled map');
    if (title == null) return;
    await fetch(`${HUB_HTTP}/api/canvases`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }),
    });
  }, []);

  const deleteCanvas = useCallback(async () => {
    if (!activeId) return;
    if (canvases.length <= 1) { window.alert('Can’t delete the last map.'); return; }
    if (!window.confirm('Delete this map? This cannot be undone.')) return;
    await fetch(`${HUB_HTTP}/api/canvases?id=${encodeURIComponent(activeId)}`, { method: 'DELETE' });
  }, [activeId, canvases.length]);

  const exportImage = useCallback(async (format: 'png' | 'svg') => {
    const editor = editorRef.current;
    if (!editor) return;
    const ids = [...editor.getCurrentPageShapeIds()];
    if (ids.length === 0) return;
    const result = await editor.toImage(ids, { format, background: true, padding: 32, scale: 2 });
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `market-map.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw shapeUtils={customShapeUtils} onMount={handleMount} />

      {/* Canvas switcher — top center */}
      <div style={switcherBar}>
        <select
          value={activeId ?? ''}
          onChange={(e) => switchCanvas(e.target.value)}
          style={select}
          title="Switch map"
        >
          {canvases.length === 0 && <option value="">(no maps)</option>}
          {canvases.map((c) => (
            <option key={c.id} value={c.id}>{c.title} ({c.nodes})</option>
          ))}
        </select>
        <button onClick={newCanvas} style={btn} title="Create a new map">+ New</button>
        <button onClick={deleteCanvas} style={{ ...btn, color: '#dc2626' }} title="Delete this map">Delete</button>
      </div>

      {/* Status + export — top right */}
      <div style={statusBar}>
        <span title="Connection to the hub server">
          <span style={{ color: status === 'connected' ? '#16a34a' : '#dc2626' }}>●</span>{' '}
          {status === 'connected' ? 'agent-synced' : 'hub offline'}
        </span>
        <button onClick={() => exportImage('png')} style={btn}>PNG</button>
        <button onClick={() => exportImage('svg')} style={btn}>SVG</button>
      </div>
    </div>
  );
}

const barBase: React.CSSProperties = {
  position: 'absolute', top: 8, zIndex: 1000, display: 'flex', gap: 8, alignItems: 'center',
  background: 'rgba(255,255,255,0.92)', borderRadius: 8, padding: '6px 10px',
  boxShadow: '0 1px 4px rgba(0,0,0,0.15)', fontFamily: 'system-ui, sans-serif', fontSize: 12,
  pointerEvents: 'all',
};
const switcherBar: React.CSSProperties = { ...barBase, left: '50%', transform: 'translateX(-50%)' };
const statusBar: React.CSSProperties = { ...barBase, right: 8 };
const btn: React.CSSProperties = {
  border: '1px solid #d1d5db', background: '#fff', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 12,
};
const select: React.CSSProperties = {
  border: '1px solid #d1d5db', background: '#fff', borderRadius: 6, padding: '3px 6px', fontSize: 12, maxWidth: 280,
};
