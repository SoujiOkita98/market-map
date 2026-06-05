#!/usr/bin/env node
/**
 * map.mjs — the agent's command-line interface to the market maps.
 *
 * This is the PRIMARY way an AI agent reads and edits a map. Every command
 * prints JSON to stdout so the agent can parse the result.
 *
 * There can be MANY maps (one JSON file each under data/maps/). One is "active"
 * at a time — the one the browser shows and the one mutating commands act on.
 * Manage maps with the `canvas` commands; everything else acts on the active map.
 *
 * Transport: if the hub server is running (default http://localhost:5174) the
 * command goes there, so changes appear live in the browser. If the hub is down,
 * the CLI edits the files directly using the same logic, and the browser picks up
 * the change when the hub next starts.
 *
 * Usage:  node cli/map.mjs <command> [args]
 *
 * Map management:
 *   canvas list                          list all maps
 *   canvas current                       show the active map
 *   canvas where                         show local map storage paths
 *   canvas new --title "..." [--id X]    create a new map and switch to it
 *   canvas use <id>                      switch the active map
 *   canvas delete <id>                   delete a map
 *
 * Editing the active map:
 *   list | summary | get <nodeId>
 *   add-node --id X --name "..." [--x N --y N --w N --h N --color C
 *            --subtitle "..." --group G --logoUrl URL --metadata '{...}']
 *   update-node <id> [--name --subtitle --color --logoUrl --x --y --w --h
 *            --group G --metadata '{...}' --merge-metadata]
 *   move <id> [--x N --y N | --dx N --dy N]
 *   connect --from A --to B [--id E --label "..."]
 *   group --id G --label "..." [--members a,b,c] [--x --y --w --h]
 *   add-source <nodeId> --url URL [--label "..."]
 *   delete-node <id> | delete-edge <id>
 *   export [--out path] | import <file.json>
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { applyCommand } from './canvas-ops.mjs';
import { auditCanvasFacts } from './facts.mjs';
import * as store from './storage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HUB = process.env.MAP_HUB || 'http://localhost:5174';

main().catch((e) => { out({ ok: false, error: e.message }); process.exit(1); });

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command || command === 'help' || command === '--help') return printHelp();

  const { positional, flags } = parseArgs(rest);

  // ---- map management --------------------------------------------------------
  if (command === 'canvas') {
    const sub = positional[0];
    if (sub === 'list') return out({ ok: true, canvases: await listCanvases() });
    if (sub === 'current') {
      const c = await readCanvas();
      return out({ ok: true, activeId: c.id ?? null, title: c.title, nodes: c.nodes.length });
    }
    if (sub === 'where') return out({ ok: true, storage: await storageLocation() });
    if (sub === 'new') {
      const created = await createCanvas({ title: flags.title ?? positional[1], id: flags.id });
      return out({ ok: true, created });
    }
    if (sub === 'use') return out({ ok: true, ...(await useCanvas(positional[1])) });
    if (sub === 'delete') return out({ ok: true, ...(await deleteCanvas(positional[1])) });
    throw new Error(`unknown canvas subcommand "${sub}" (list|current|where|new|use|delete)`);
  }

  // ---- read-only on the active map ------------------------------------------
  if (command === 'list') return out({ ok: true, canvas: await readCanvas() });
  if (command === 'summary') return out({ ok: true, summary: summarize(await readCanvas()) });
  if (command === 'audit') {
    const audit = auditCanvasFacts(await readCanvas());
    return out({ ok: audit.ok, audit });
  }
  if (command === 'get') {
    const canvas = await readCanvas();
    const node = canvas.nodes.find((n) => n.id === positional[0]);
    return out(node ? { ok: true, node } : { ok: false, error: `node "${positional[0]}" not found` });
  }
  if (command === 'export') {
    const canvas = await readCanvas();
    const stamp = store.slug(canvas.title || canvas.id || 'map');
    const outPath = flags.out ? resolve(flags.out) : join(ROOT, 'exports', `${stamp}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(canvas, null, 2) + '\n');
    return out({ ok: true, exported: outPath });
  }
  if (command === 'import') {
    const file = positional[0];
    if (!file) throw new Error('import requires a file path');
    const canvas = JSON.parse(await readFile(resolve(file), 'utf8'));
    await replaceCanvas(canvas);
    return out({ ok: true, imported: file, nodes: canvas.nodes?.length ?? 0 });
  }

  // ---- mutate the active map ------------------------------------------------
  const cmd = buildCommand(command, positional, flags);
  const result = await dispatch(cmd);
  out({ ok: true, ...result });
}

function buildCommand(command, positional, flags) {
  const meta = flags.metadata !== undefined ? parseJsonFlag('metadata', flags.metadata) : undefined;
  switch (command) {
    case 'add-node':
      return clean({ action: 'add-node', id: flags.id, name: flags.name, subtitle: flags.subtitle,
        x: flags.x, y: flags.y, w: flags.w, h: flags.h, color: flags.color, group: flags.group,
        logoUrl: flags.logoUrl, metadata: meta });
    case 'update-node':
      return clean({ action: 'update-node', id: positional[0], name: flags.name, subtitle: flags.subtitle,
        color: flags.color, logoUrl: flags.logoUrl, x: flags.x, y: flags.y, w: flags.w, h: flags.h,
        group: flags.group, metadata: meta, mergeMetadata: flags['merge-metadata'] === true });
    case 'move':
      return clean({ action: 'move', id: positional[0], x: flags.x, y: flags.y, dx: flags.dx, dy: flags.dy });
    case 'connect':
      return clean({ action: 'connect', id: flags.id, from: flags.from, to: flags.to, label: flags.label });
    case 'group':
      return clean({ action: 'group', id: flags.id, label: flags.label,
        members: flags.members ? String(flags.members).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        x: flags.x, y: flags.y, w: flags.w, h: flags.h });
    case 'add-source':
      return clean({ action: 'add-source', id: positional[0], url: flags.url, label: flags.label });
    case 'add-fact':
      return clean({
        action: 'add-fact',
        id: positional[0],
        key: flags.key,
        value: flags.value,
        asOf: flags.asOf,
        sourceLabel: flags['source-label'],
        sourceUrl: flags['source-url'],
        note: flags.note,
      });
    case 'delete-node':
      return { action: 'delete-node', id: positional[0] };
    case 'delete-edge':
      return { action: 'delete-edge', id: positional[0] };
    default:
      throw new Error(`unknown command "${command}" (run: node cli/map.mjs help)`);
  }
}

// ---- transport: hub when up, files when down -------------------------------
async function hub(path, init) {
  const res = await fetch(`${HUB}${path}`, { signal: AbortSignal.timeout(1500), ...init });
  const body = await res.json();
  if (!body.ok) { const e = new Error(body.error || 'hub error'); e.isUserError = res.status === 400; throw e; }
  return body;
}
function post(path, obj) {
  return hub(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
}

async function dispatch(cmd) {
  try {
    const body = await post('/api/command', cmd);
    return { via: 'hub', result: body.result };
  } catch (e) {
    if (e.isUserError) throw e;
    const { id, canvas } = await store.readActiveCanvas();
    if (!canvas) throw new Error('no active map (hub offline and none on disk)');
    const result = applyCommand(canvas, cmd);
    await store.writeCanvasById(id, canvas);
    return { via: 'file (hub offline)', result };
  }
}

async function readCanvas() {
  try { return (await hub('/api/canvas')).canvas; }
  catch { const { canvas } = await store.readActiveCanvas(); return canvas ?? emptyView(); }
}

async function listCanvases() {
  try { return (await hub('/api/canvases')).canvases; }
  catch { return store.listCanvases(); }
}

async function createCanvas(opts) {
  try { return (await post('/api/canvases', opts)).created; }
  catch (e) { if (e.isUserError) throw e; return store.createCanvas(opts).then((c) => (store.setActiveId(c.id), c)); }
}

async function useCanvas(id) {
  if (!id) throw new Error('canvas use requires an id');
  try { const b = await post('/api/active', { id }); return { activeId: b.activeId }; }
  catch (e) {
    if (e.isUserError) throw e;
    if (!(await store.readCanvasById(id))) throw new Error(`canvas "${id}" not found`);
    await store.setActiveId(id);
    return { activeId: id };
  }
}

async function deleteCanvas(id) {
  if (!id) throw new Error('canvas delete requires an id');
  try { const b = await hub(`/api/canvases?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); return { deleted: id, activeId: b.activeId }; }
  catch (e) { if (e.isUserError) throw e; await store.deleteCanvasById(id); return { deleted: id }; }
}

async function storageLocation() {
  const activeId = await store.readActiveId();
  return {
    mode: 'local filesystem',
    mapsDir: store.storagePaths.maps,
    activeFile: store.storagePaths.active,
    activeId,
    activeMapFile: activeId ? store.mapFileFor(activeId) : null,
  };
}

async function replaceCanvas(canvas) {
  try { await post('/api/canvas', canvas); }
  catch (e) {
    if (e.isUserError) throw e;
    const { id } = await store.readActiveCanvas();
    await store.writeCanvasById(id, canvas);
  }
}

function emptyView() { return { nodes: [], edges: [], groups: [], title: 'Untitled map' }; }

function summarize(canvas) {
  const groupOf = (id) => canvas.groups.find((g) => g.id === id)?.label;
  return {
    title: canvas.title,
    nodes: canvas.nodes.map((n) => ({ id: n.id, name: n.name, at: [n.x, n.y], group: n.groupId ? groupOf(n.groupId) : null })),
    edges: canvas.edges.map((e) => `${e.from} --${e.label || ''}--> ${e.to}`),
    groups: canvas.groups.map((g) => ({ id: g.id, label: g.label, members: canvas.nodes.filter((n) => n.groupId === g.id).map((n) => n.id) })),
  };
}

// ---- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

function parseJsonFlag(name, val) {
  try { return JSON.parse(val); } catch { throw new Error(`--${name} must be valid JSON, got: ${val}`); }
}

function clean(obj) {
  const o = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) o[k] = v;
  return o;
}

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

function printHelp() {
  process.stdout.write(`market-map CLI — the agent's interface to the maps\n\n` +
    `MAPS:\n` +
    `  node cli/map.mjs canvas list | current | where\n` +
    `  node cli/map.mjs canvas new --title "AI Chips Landscape"\n` +
    `  node cli/map.mjs canvas use <id> | canvas delete <id>\n\n` +
    `ACTIVE MAP:\n` +
    `  node cli/map.mjs list | summary | get <id>\n` +
    `  node cli/map.mjs add-node --id aws --name "AWS" --x 320 --y 0 [--group cloud --metadata '{"revenue":"..."}']\n` +
    `  node cli/map.mjs update-node aws --color orange --metadata '{"revenue":"X"}' --merge-metadata\n` +
    `  node cli/map.mjs move aws --x 500 --y 100   (or --dx 50 --dy 0)\n` +
    `  node cli/map.mjs connect --from aws --to enterprise --label serves\n` +
    `  node cli/map.mjs group --id cloud --label "Cloud Infrastructure" --members aws,azure,gcp\n` +
    `  node cli/map.mjs add-source aws --label "10-K 2024" --url https://...\n` +
    `  node cli/map.mjs add-fact aws --key revenue --value "$100B" --asOf 2024-12-31 --source-url https://...\n` +
    `  node cli/map.mjs audit\n` +
    `  node cli/map.mjs delete-node aws | delete-edge e_aws_ent\n` +
    `  node cli/map.mjs export [--out file.json] | import file.json\n\n` +
    `Hub: ${HUB} (set MAP_HUB to override). Falls back to data/maps/ files when the hub is offline.\n`);
}
