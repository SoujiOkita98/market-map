/**
 * Hub server — the single source of truth for the live maps.
 *
 *   Agent (CLI) ──HTTP──►  HUB  ◄──WebSocket──►  Browser (tldraw)
 *                          owns data/maps/<id>.json + data/active.json
 *
 * Holds MANY maps on disk (one JSON file each) and keeps an "active" one open.
 * The active map is what the browser shows and what agent commands mutate.
 *
 *  HTTP:
 *   GET  /api/health
 *   GET  /api/canvas            -> { activeId, canvas, canvases }
 *   GET  /api/canvases          -> { canvases }
 *   POST /api/command           -> apply an op to the active map
 *   POST /api/canvas            -> replace the active map's content (import)
 *   POST /api/canvases {title}  -> create a new map and switch to it
 *   POST /api/active   {id}     -> switch the active map
 *   DELETE /api/canvases?id=ID  -> delete a map
 *
 *  WS (browser):
 *   server -> { type:'canvas', activeId, canvas }   (render this)
 *   server -> { type:'canvases', canvases }         (the switcher list)
 *   browser -> { type:'human-update', canvas }      (human edited the active map)
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { applyCommand } from '../cli/canvas-ops.mjs';
import {
  ensureInit, listCanvases, readActiveCanvas, readCanvasById,
  writeCanvasById, setActiveId, createCanvas, deleteCanvasById,
} from '../cli/storage.mjs';

const PORT = Number(process.env.PORT) || 5174;

let activeId = null;
let canvas = null;

async function loadActive() {
  const a = await readActiveCanvas();
  activeId = a.id;
  canvas = a.canvas;
}

let persistTimer = null;
function persistSoon() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (activeId && canvas) writeCanvasById(activeId, canvas).catch(console.error);
  }, 150);
}

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function canvasMsg() { return JSON.stringify({ type: 'canvas', activeId, canvas }); }
function broadcastCanvas(except) {
  const msg = canvasMsg();
  for (const ws of clients) if (ws !== except && ws.readyState === ws.OPEN) ws.send(msg);
}
async function broadcastList() {
  const msg = JSON.stringify({ type: 'canvases', canvases: await listCanvases() });
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

wss.on('connection', async (ws) => {
  clients.add(ws);
  ws.send(canvasMsg());
  ws.send(JSON.stringify({ type: 'canvases', canvases: await listCanvases() }));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'human-update' && msg.canvas) {
      canvas = { ...msg.canvas, id: activeId, title: canvas?.title ?? msg.canvas.title };
      persistSoon();
      broadcastCanvas(ws);
    }
  });
  ws.on('close', () => clients.delete(ws));
});

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/api/health') {
      return sendJson(res, 200, { ok: true, clients: clients.size, activeId });
    }
    if (req.method === 'GET' && p === '/api/canvas') {
      return sendJson(res, 200, { ok: true, activeId, canvas, canvases: await listCanvases() });
    }
    if (req.method === 'GET' && p === '/api/canvases') {
      return sendJson(res, 200, { ok: true, canvases: await listCanvases() });
    }

    if (req.method === 'POST' && p === '/api/command') {
      const cmd = await readBody(req);
      const result = applyCommand(canvas, cmd);
      persistSoon();
      broadcastCanvas();
      return sendJson(res, 200, { ok: true, result, activeId, canvas });
    }

    if (req.method === 'POST' && p === '/api/canvas') {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.nodes)) throw userErr('invalid canvas payload');
      canvas = { ...body, id: activeId, title: body.title ?? canvas?.title };
      persistSoon();
      broadcastCanvas();
      return sendJson(res, 200, { ok: true, activeId, canvas });
    }

    if (req.method === 'POST' && p === '/api/canvases') {
      const body = await readBody(req);
      const created = await createCanvas({ title: body.title, id: body.id });
      await setActiveId(created.id);
      activeId = created.id;
      canvas = created;
      broadcastCanvas();
      await broadcastList();
      return sendJson(res, 200, { ok: true, activeId, canvas, created });
    }

    if (req.method === 'POST' && p === '/api/active') {
      const body = await readBody(req);
      const target = await readCanvasById(body.id);
      if (!target) throw userErr(`canvas "${body.id}" not found`);
      await setActiveId(body.id);
      activeId = body.id;
      canvas = target;
      broadcastCanvas();
      await broadcastList();
      return sendJson(res, 200, { ok: true, activeId, canvas });
    }

    if (req.method === 'DELETE' && p === '/api/canvases') {
      const id = url.searchParams.get('id');
      if (!id) throw userErr('delete requires ?id=');
      await deleteCanvasById(id);
      await loadActive(); // active pointer may have moved
      broadcastCanvas();
      await broadcastList();
      return sendJson(res, 200, { ok: true, deleted: id, activeId });
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return sendJson(res, e.isUserError ? 400 : 500, { ok: false, error: e.message });
  }
});

function userErr(msg) { const e = new Error(msg); e.isUserError = true; return e; }

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  if (pathname === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else socket.destroy();
});

await ensureInit();
await loadActive();
server.listen(PORT, async () => {
  const list = await listCanvases();
  console.log(`[hub] http://localhost:${PORT}  ws://localhost:${PORT}/ws`);
  console.log(`[hub] ${list.length} map(s) in data/maps/; active="${activeId}" (${canvas?.nodes?.length ?? 0} nodes)`);
});
