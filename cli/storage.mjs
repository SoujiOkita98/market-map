/**
 * storage.mjs — where maps live on disk.
 *
 * One map = one JSON file under data/maps/<id>.json. A tiny pointer file
 * data/active.json records which map is currently "open". No database, and
 * nothing in the browser — the agent operates on these files (directly when the
 * hub is offline, or through the hub when it's up), so the state has to live
 * somewhere the agent can reach: the filesystem.
 *
 * Shared by the hub server and the CLI so both agree on layout and ids.
 */
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');
const MAPS = join(DATA, 'maps');
const ACTIVE = join(DATA, 'active.json');
const LEGACY = join(DATA, 'canvas.json');

export function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'map';
}

const fileFor = (id) => join(MAPS, `${id}.json`);
export const storagePaths = { root: ROOT, data: DATA, maps: MAPS, active: ACTIVE };
export const mapFileFor = fileFor;

export function newCanvasObject(title, id) {
  return { id: id || slug(title), version: 1, title: title || 'Untitled map', nodes: [], edges: [], groups: [] };
}

async function writeJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n');
}

/** First run: create the maps folder, migrate a legacy single canvas.json, and
 *  guarantee there is always at least one map and a valid active pointer. */
export async function ensureInit() {
  await mkdir(MAPS, { recursive: true });
  const files = (await readdir(MAPS)).filter((f) => f.endsWith('.json'));

  if (files.length === 0) {
    if (existsSync(LEGACY)) {
      const c = JSON.parse(await readFile(LEGACY, 'utf8'));
      c.id = c.id || slug(c.title);
      c.title = c.title || 'Untitled map';
      await writeJson(fileFor(c.id), c);
      await setActiveId(c.id);
      await rm(LEGACY).catch(() => {});
    } else {
      const c = newCanvasObject('Untitled map');
      await writeJson(fileFor(c.id), c);
      await setActiveId(c.id);
    }
  }

  // Make sure the active pointer references an existing map.
  const list = await listCanvases();
  const active = await readActiveId();
  if (!active || !list.find((x) => x.id === active)) {
    await setActiveId(list[0]?.id ?? null);
  }
}

export async function listCanvases() {
  await mkdir(MAPS, { recursive: true });
  const files = (await readdir(MAPS)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const c = JSON.parse(await readFile(join(MAPS, f), 'utf8'));
      out.push({
        id: c.id || f.replace(/\.json$/, ''),
        title: c.title || 'Untitled',
        nodes: (c.nodes || []).length,
        edges: (c.edges || []).length,
        groups: (c.groups || []).length,
      });
    } catch { /* skip unreadable file */ }
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

export async function readActiveId() {
  if (!existsSync(ACTIVE)) return null;
  try { return JSON.parse(await readFile(ACTIVE, 'utf8')).activeId ?? null; } catch { return null; }
}

export async function setActiveId(id) {
  await writeJson(ACTIVE, { activeId: id });
  return id;
}

export async function readCanvasById(id) {
  if (!id) return null;
  const p = fileFor(id);
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, 'utf8'));
}

export async function writeCanvasById(id, canvas) {
  canvas.id = id;
  await writeJson(fileFor(id), canvas);
  return canvas;
}

async function uniqueId(base) {
  const ids = new Set((await listCanvases()).map((x) => x.id));
  let id = base || 'map';
  let i = 2;
  while (ids.has(id)) id = `${base}-${i++}`;
  return id;
}

export async function createCanvas({ title, id } = {}) {
  const theId = await uniqueId(slug(id || title || 'map'));
  const c = newCanvasObject(title || 'Untitled map', theId);
  await writeCanvasById(theId, c);
  return c;
}

export async function deleteCanvasById(id) {
  const p = fileFor(id);
  if (existsSync(p)) await rm(p);
  if ((await readActiveId()) === id) {
    const list = await listCanvases();
    await setActiveId(list[0]?.id ?? null);
  }
  return true;
}

export async function readActiveCanvas() {
  const id = await readActiveId();
  return { id, canvas: await readCanvasById(id) };
}
