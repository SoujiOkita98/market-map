/**
 * canvas-ops.mjs — pure operations on the agent-facing domain model.
 *
 * The domain model (data/canvas.json) is deliberately simple and stable:
 *   { version, title, nodes[], edges[], groups[] }
 * The tldraw browser app translates this into real shapes/bindings; the agent
 * never touches raw tldraw records. These functions are the single source of
 * truth for HOW a command mutates the map, and are used both by the hub server
 * (POST /api/command) and by the CLI's offline fallback. Each mutates `canvas`
 * in place and returns a small result describing what happened.
 */

const DEFAULT_NODE = { type: 'company', w: 240, h: 140, color: 'blue', logoUrl: null, groupId: null, metadata: {}, sources: [] };

function err(msg) {
  const e = new Error(msg);
  e.isUserError = true;
  return e;
}

export function emptyCanvas() {
  return { version: 1, title: 'Untitled map', nodes: [], edges: [], groups: [] };
}

export function findNode(canvas, id) {
  return canvas.nodes.find((n) => n.id === id);
}
export function findEdge(canvas, id) {
  return canvas.edges.find((e) => e.id === id);
}
export function findGroup(canvas, id) {
  return canvas.groups.find((g) => g.id === id);
}

/** Bounding box of a set of node ids, with padding. */
function boundsOf(canvas, nodeIds, pad = 28) {
  const ns = nodeIds.map((id) => findNode(canvas, id)).filter(Boolean);
  if (ns.length === 0) return null;
  const minX = Math.min(...ns.map((n) => n.x));
  const minY = Math.min(...ns.map((n) => n.y));
  const maxX = Math.max(...ns.map((n) => n.x + n.w));
  const maxY = Math.max(...ns.map((n) => n.y + n.h));
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 + 24 };
}

export function addNode(canvas, args) {
  if (!args.id) throw err('add-node requires --id');
  if (findNode(canvas, args.id)) throw err(`node "${args.id}" already exists (use update-node)`);
  const node = {
    ...DEFAULT_NODE,
    id: args.id,
    name: args.name ?? args.id,
    subtitle: args.subtitle ?? '',
    x: num(args.x, 0),
    y: num(args.y, 0),
    w: num(args.w, DEFAULT_NODE.w),
    h: num(args.h, DEFAULT_NODE.h),
    color: args.color ?? DEFAULT_NODE.color,
    logoUrl: args.logoUrl ?? null,
    groupId: args.group ?? null,
    metadata: args.metadata ?? {},
    sources: args.sources ?? [],
  };
  if (node.groupId && !findGroup(canvas, node.groupId)) throw err(`group "${node.groupId}" does not exist (create it first with: group)`);
  canvas.nodes.push(node);
  return { action: 'add-node', node };
}

export function updateNode(canvas, id, args) {
  const node = findNode(canvas, id);
  if (!node) throw err(`node "${id}" not found`);
  for (const k of ['name', 'subtitle', 'color', 'logoUrl']) if (args[k] !== undefined) node[k] = args[k];
  for (const k of ['x', 'y', 'w', 'h']) if (args[k] !== undefined) node[k] = num(args[k], node[k]);
  if (args.group !== undefined) {
    const g = args.group === '' || args.group === null ? null : args.group;
    if (g && !findGroup(canvas, g)) throw err(`group "${g}" does not exist`);
    node.groupId = g;
  }
  if (args.metadata !== undefined) {
    node.metadata = args.mergeMetadata ? { ...node.metadata, ...args.metadata } : args.metadata;
  }
  return { action: 'update-node', node };
}

export function moveNode(canvas, id, args) {
  const node = findNode(canvas, id);
  if (!node) throw err(`node "${id}" not found`);
  if (args.dx !== undefined) node.x += num(args.dx, 0);
  if (args.dy !== undefined) node.y += num(args.dy, 0);
  if (args.x !== undefined) node.x = num(args.x, node.x);
  if (args.y !== undefined) node.y = num(args.y, node.y);
  return { action: 'move', node };
}

export function connect(canvas, args) {
  const from = args.from, to = args.to;
  if (!from || !to) throw err('connect requires --from and --to');
  if (!findNode(canvas, from)) throw err(`node "${from}" not found`);
  if (!findNode(canvas, to)) throw err(`node "${to}" not found`);
  const id = args.id ?? `e_${from}_${to}`;
  let edge = findEdge(canvas, id);
  if (edge) {
    edge.from = from; edge.to = to;
    if (args.label !== undefined) edge.label = args.label;
  } else {
    edge = { id, from, to, label: args.label ?? '' };
    canvas.edges.push(edge);
  }
  return { action: 'connect', edge };
}

export function group(canvas, args) {
  if (!args.id) throw err('group requires --id');
  const members = args.members ?? [];
  let g = findGroup(canvas, args.id);
  if (!g) {
    g = { id: args.id, label: args.label ?? args.id, x: 0, y: 0, w: 200, h: 200 };
    canvas.groups.push(g);
  } else if (args.label !== undefined) {
    g.label = args.label;
  }
  // Assign members to this group.
  for (const m of members) {
    const node = findNode(canvas, m);
    if (!node) throw err(`cannot group: node "${m}" not found`);
    node.groupId = g.id;
  }
  // Auto-fit the frame to its members unless explicit geometry was given.
  const memberIds = canvas.nodes.filter((n) => n.groupId === g.id).map((n) => n.id);
  const autoBounds = boundsOf(canvas, memberIds);
  if (args.x !== undefined) g.x = num(args.x, g.x);
  else if (autoBounds) g.x = autoBounds.x;
  if (args.y !== undefined) g.y = num(args.y, g.y);
  else if (autoBounds) g.y = autoBounds.y;
  if (args.w !== undefined) g.w = num(args.w, g.w);
  else if (autoBounds) g.w = autoBounds.w;
  if (args.h !== undefined) g.h = num(args.h, g.h);
  else if (autoBounds) g.h = autoBounds.h;
  return { action: 'group', group: g, members: memberIds };
}

export function addSource(canvas, id, args) {
  const node = findNode(canvas, id);
  if (!node) throw err(`node "${id}" not found`);
  if (!args.url) throw err('add-source requires --url');
  node.sources = node.sources ?? [];
  node.sources.push({ label: args.label ?? args.url, url: args.url });
  return { action: 'add-source', node };
}

export function deleteNode(canvas, id) {
  if (!findNode(canvas, id)) throw err(`node "${id}" not found`);
  canvas.nodes = canvas.nodes.filter((n) => n.id !== id);
  canvas.edges = canvas.edges.filter((e) => e.from !== id && e.to !== id);
  return { action: 'delete-node', id };
}

export function deleteEdge(canvas, id) {
  if (!findEdge(canvas, id)) throw err(`edge "${id}" not found`);
  canvas.edges = canvas.edges.filter((e) => e.id !== id);
  return { action: 'delete-edge', id };
}

/** Central dispatcher used by the server. */
export function applyCommand(canvas, cmd) {
  switch (cmd.action) {
    case 'add-node': return addNode(canvas, cmd);
    case 'update-node': return updateNode(canvas, cmd.id, cmd);
    case 'move': return moveNode(canvas, cmd.id, cmd);
    case 'connect': return connect(canvas, cmd);
    case 'group': return group(canvas, cmd);
    case 'add-source': return addSource(canvas, cmd.id, cmd);
    case 'delete-node': return deleteNode(canvas, cmd.id);
    case 'delete-edge': return deleteEdge(canvas, cmd.id);
    default: throw err(`unknown action "${cmd.action}"`);
  }
}

function num(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
