# Market Map

An **agent-collaborative market mapping tool** built on [tldraw](https://github.com/tldraw/tldraw).
A human and an AI agent co-create on the same infinite canvas: the human drags and
edits in the browser, the agent reads and edits through a CLI, and both see the same
live map.

```
  Agent (CLI)  ──HTTP──►   HUB server   ◄──WebSocket──►   Browser (tldraw)
                           owns data/canvas.json
  "add AWS, connect it to enterprise, group the clouds"
        │                       │                              ▲
        └─ node cli/map.mjs ────┘   broadcast change ──────────┘
  Human drags a node ──────────────────────────────────────────► saved back to canvas.json
```

## The core idea

The map lives in **one JSON file** (`data/canvas.json`) in a simple, stable shape:
`nodes`, `edges`, `groups`. This is the *domain model* the agent reads and writes —
it never touches tldraw's verbose internal records. A small **hub server** owns that
file and keeps the browser and the agent in sync in real time.

- **Agent edits** go through the hub and appear on the canvas instantly.
- **Human edits** in the browser are saved back into the active map's JSON file.
- Because there is one owner of the state, the two never fight over the file.

You can keep **many maps** — one JSON file each under `data/maps/`. One map is
"active" at a time (the one the browser shows and the one agent commands act on),
tracked by `data/active.json`. No database, and nothing stored in the browser:
state lives on disk so the agent can always reach it.

## Quick start

```bash
# from the project root — install once (root deps + the app's deps)
pnpm install && pnpm --prefix app install     # or: npm run setup

npm run dev          # starts the hub (:5174) AND the tldraw app (:5173) together
npm run stop         # closes any running Market Map dev server for this repo
```

Open **http://localhost:5173**. You should see the demo cloud-infrastructure map.
The badge top-right shows **agent-synced** (green) when the hub is connected.

`npm run dev` also clears stale Market Map dev processes from the default local
ports first, so a forgotten previous run should not push Vite onto a fallback
port.

Then, in another terminal, act as the agent:

```bash
node cli/map.mjs summary
node cli/map.mjs add-node --id oci --name "Oracle Cloud" --x 1160 --y 0 --color red
node cli/map.mjs group --id cloud --members oci          # drops it into the Cloud frame
node cli/map.mjs connect --from oci --to enterprise --label serves
```

The new node and arrow appear on the canvas without a reload.

## Project layout

| Path | What it is |
|------|------------|
| `app/` | The tldraw frontend (Vite + React + TypeScript). |
| `app/src/CompanyShape.tsx` | The custom **Company Node** shape (visual + metadata). |
| `app/src/sync.ts` | Translates domain JSON ⇄ tldraw shapes; the live WebSocket sync. |
| `server/index.mjs` | The **hub** — owns the map files, HTTP for the agent, WS for the browser. |
| `cli/map.mjs` | The **agent's CLI** — the main way an agent reads and edits maps. |
| `cli/canvas-ops.mjs` | Pure mutation logic, shared by the hub and the CLI. |
| `cli/storage.mjs` | Disk layout: reading/writing/listing map files + the active pointer. |
| `data/maps/<id>.json` | One file per map (nodes/edges/groups). The source of truth. |
| `data/active.json` | Pointer to the currently-open map. |
| `sources/` | Saved source links / research snippets (for later). |
| `exports/` | Generated JSON / PNG / SVG exports. |

---

## How an AI agent should use this map

You (the agent) interact with the map through **`node cli/map.mjs <command>`**.
Every command prints JSON to stdout, so you can parse the result. Work in this loop:

1. **Read the current state first.** Run `node cli/map.mjs summary` (compact) or
   `node cli/map.mjs list` (full JSON). Never guess what's on the canvas — read it.
2. **Make one change per command.** Add a node, move it, connect it, group it.
3. **Re-read if you need to confirm**, then continue.

### The data model

```jsonc
{
  "title": "…",
  "nodes": [
    {
      "id": "aws",                 // stable, human-readable id you choose
      "name": "AWS",
      "subtitle": "Cloud infrastructure",
      "x": 320, "y": 0,            // ABSOLUTE canvas coordinates (page space)
      "w": 240, "h": 150,
      "color": "orange",           // blue|orange|violet|green|red|grey|yellow
      "logoUrl": null,             // a URL to a logo image, or null
      "groupId": "cloud",          // id of the group it belongs to, or null
      "metadata": { "revenue": "…", "role": "…" },  // any JSON you research
      "sources": [ { "label": "10-K 2024", "url": "https://…" } ]
    }
  ],
  "edges": [ { "id": "e_aws_ent", "from": "aws", "to": "enterprise", "label": "serves" } ],
  "groups": [ { "id": "cloud", "label": "Cloud Infrastructure", "x": 296, "y": -24, "w": 848, "h": 198 } ]
}
```

Coordinates are **absolute**. Nodes are ~240×140. To place things "next to" each
other, step x by ~280. To stack, step y by ~190.

### Commands

**Managing maps** (which map you're working on):

```bash
node cli/map.mjs canvas list                  # all maps
node cli/map.mjs canvas current               # the active map
node cli/map.mjs canvas where                 # local data folder + active map file
node cli/map.mjs canvas new --title "AI Chips Landscape"   # create + switch to it
node cli/map.mjs canvas use <id>              # switch the active map
node cli/map.mjs canvas delete <id>           # delete a map
```

Everything below acts on the **active** map.

```bash
node cli/map.mjs list                       # full canvas JSON
node cli/map.mjs summary                     # compact overview (best for reading)
node cli/map.mjs get <nodeId>                # one node
node cli/map.mjs audit                       # check numeric facts have dates/sources

node cli/map.mjs add-node --id aws --name "AWS" --x 320 --y 0 \
    [--w 240 --h 150 --color orange --subtitle "Cloud infrastructure" \
     --group cloud --logoUrl https://… --metadata '{"revenue":"…","role":"…"}']

node cli/map.mjs update-node aws --color orange \
    --metadata '{"revenue":"~$100B"}' --merge-metadata    # merge, don't replace

node cli/map.mjs add-fact aws --key revenue --value "$100B" \
    --asOf 2024-12-31 --source-label "FY 2024 10-K" --source-url https://…

node cli/map.mjs move aws --x 500 --y 100                  # absolute
node cli/map.mjs move aws --dx 280 --dy 0                  # relative

node cli/map.mjs connect --from aws --to enterprise --label serves

node cli/map.mjs group --id cloud --label "Cloud Infrastructure" --members aws,azure,gcp
# The group frame auto-fits around its members. Add more later with --members.

node cli/map.mjs add-source aws --label "10-K 2024" --url https://…

node cli/map.mjs delete-node aws
node cli/map.mjs delete-edge e_aws_ent

node cli/map.mjs export [--out file.json]    # write current map JSON to exports/
node cli/map.mjs import map.json             # replace the whole canvas
```

PNG/SVG export is done from the **browser** (the PNG / SVG buttons, top-right),
because only the live tldraw editor can render shapes to an image.

### Research data discipline

Treat the canvas as a research artifact, not just a drawing. Any quantitative
claim should be stored as a fact object with:

```json
{
  "value": "$100B",
  "asOf": "2024-12-31",
  "source": { "label": "FY 2024 10-K", "url": "https://…" },
  "note": "optional context"
}
```

Use `add-fact` for valuation, revenue, income, headcount, market share, growth,
multiples, or any other number that could go stale. Use `audit` before relying on
or publishing a map; it flags numeric-looking metadata that is not backed by a
date and source.

### Worked example — the use case from the brief

> "Start with Amazon. Add a box for AWS next to it. Draw a line from AWS to
> enterprise customers. Now add Azure and GCP next to AWS and group them as
> Cloud Infrastructure."

```bash
node cli/map.mjs add-node --id amazon --name "Amazon" --x -40 --y -260 --color blue
node cli/map.mjs add-node --id aws --name "AWS" --x 320 --y 0 --color orange
node cli/map.mjs connect --from amazon --to aws --label owns
node cli/map.mjs add-node --id enterprise --name "Enterprise Customers" --x 600 --y 360 --color grey
node cli/map.mjs connect --from aws --to enterprise --label serves
node cli/map.mjs add-node --id azure --name "Microsoft Azure" --x 600 --y 0 --color violet
node cli/map.mjs add-node --id gcp --name "Google Cloud" --x 880 --y 0 --color green
node cli/map.mjs group --id cloud --label "Cloud Infrastructure" --members aws,azure,gcp
```

### Notes for the agent

- **Logos and data come later.** Set `logoUrl` to a real image URL and put
  researched facts in `metadata`; both render on the node. Use `add-source` to
  keep citations.
- **The hub doesn't have to be running.** If it's down, the CLI edits
  `data/canvas.json` directly (it tells you `"via": "file (hub offline)"`), and the
  browser picks up the file when the hub next starts. The live experience needs the
  hub up (`npm run dev`).
- **Read before you write.** The human may have moved or edited things; the canvas
  is shared.

## Configuration

- Hub port: `PORT=5174` (env var on the server).
- App points at the hub via `VITE_HUB_WS` (default `ws://localhost:5174/ws`).
- CLI points at the hub via `MAP_HUB` (default `http://localhost:5174`).

## Status

This proves the co-creation loop (human ⇄ JSON ⇄ agent ⇄ canvas) with company
nodes, edges, and groups, across **multiple named maps** you can create and switch
between. The UI is intentionally minimal.

Known limits (next steps): brand-new free-form shapes a human draws from scratch
aren't persisted yet (only the company nodes / groups / edges round-trip); no
per-map version history; single-user (no live multi-cursor).

## License

The original code in this repository (hub, CLI, sync layer, custom shape, glue) is
licensed **MIT** — see [LICENSE](./LICENSE).

This project is **built on [tldraw](https://tldraw.dev)**, which is **not** open
source. tldraw is distributed under the proprietary **tldraw license**:

- **Free for development.** Running it locally to build and test is fine.
- **Production / commercial use requires a paid tldraw license.** If you deploy this
  as a product or use it commercially in production, get a license from tldraw.
- **Keep the watermark.** tldraw shows a "Get a license for production" badge; do not
  remove or interfere with it unless you hold a license.

tldraw's source is not included here — it is installed from npm — so this repo does
not redistribute it. Respect tldraw's license: https://github.com/tldraw/tldraw/blob/main/LICENSE.md
