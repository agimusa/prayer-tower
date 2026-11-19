# prayer-tower-mcp

An [MCP](https://modelcontextprotocol.io) server for managing the AGIM **Prayer Tower** slideshow
(`agimusa/prayer-tower`, served by GitHub Pages from `main`). It lets Claude Desktop or Claude Code add,
edit, move, answer and archive bilingual (English + Telugu) prayer requests in `data/prayers.json`,
and publish them to GitHub, either as a pull request or straight to the live site.

> "Add prayer request for Samuel Newton, Twinkle Amjala's elder brother: healing from diabetes complications…"
>
> Claude searches for existing entries, calls `add_prayer_request` with English **and** Telugu (Claude writes
> the translation), shows `preview_changes`, and after you say OK calls `publish`.

The server does **not** translate. The calling model supplies the Telugu and marks it `te_status: "auto"`.
Use the `telugu_review` prompt later so a Telugu reader can confirm it, which upgrades it to `"human"`.

## Hosted (claude.ai web & mobile)

The same tools also run as a hosted server (`server.js` → `dist/http.bundle.mjs`, source `src/http.ts`):
MCP over Streamable HTTP, with OAuth where each person signs in with GitHub and must be on an allow list.
Add it in claude.ai as a custom connector at `https://<host>/mcp`. It then works in the browser and the Claude mobile app.
**[HOSTING.md](HOSTING.md)** walks a non-developer through Hostinger setup: GitHub OAuth App, token, environment variables, connector, and troubleshooting.

## Setup

Requires Node.js 20 to 24 (22 recommended; see `.nvmrc`).

```bash
cd mcp
npm install
npm run build        # -> dist/index.js
npm test             # offline unit + in-process MCP tests
npm run smoke        # spawns dist/index.js over stdio against a temp copy of data/prayers.json
```

| Script | What it does |
|---|---|
| `npm run build` | `tsc` → `dist/*.js` (stdio server `dist/index.js`, hosted `dist/http.js`), then `bundle` |
| `npm run bundle` | esbuild → `dist/http.bundle.mjs`, the hosted server in one file. It needs only regular dependencies, and it is Hostinger's build command |
| `npm run package:hostinger` | `bundle`, then writes `release/prayer-tower-mcp-hostinger.zip` (`package.json` + `server.js` + bundle, nothing to install) |
| `npm start` | Hosted HTTP server (`node server.js`), configured by env vars. See HOSTING.md |
| `npm run start:stdio` | stdio server (`node dist/index.js`) |
| `npm test` / `npm run smoke` | Unit + in-process MCP + HTTP/OAuth tests / stdio smoke test |

## Modes

The mode comes from environment variables. If neither variable is set, the server exits and prints how to configure it.

| Mode | Env | What writes do | What `publish` does |
|---|---|---|---|
| **GitHub** | `GITHUB_TOKEN` (+ optional `PRAYER_TOWER_REPO`=`agimusa/prayer-tower`, `PRAYER_TOWER_BRANCH`=`main`, `PRAYER_TOWER_FILE`=`data/prayers.json`, `PRAYER_TOWER_PUBLISH_MODE`=`pr`\|`direct`) | Change an in-memory draft and append to an ops log | Re-fetches the latest file from `main`, replays your ops onto it so edits made on the website meanwhile are kept, validates it, then opens a PR (default) or commits directly |
| **Local** | `PRAYER_TOWER_REPO_PATH=<checkout path>` | Write `data/prayers.json` immediately (validated, atomic temp-file + rename) | Shows the diff and suggested commit message. It does **not** run git, so you commit and push yourself |

If both are set, local mode wins.

### Publish safety

- **Default: pull request.** Creates branch `prayer-update-YYYYMMDD-HHMMSS` from `main`, commits there, and opens a PR.
  The site changes only after someone merges it.
- **Direct.** `publish { direct: true, confirm: true }` commits straight to `main`, and the live site updates within a minute or two.
  `confirm: true` is mandatory. Claude is told to set it only after it shows you `preview_changes` and you explicitly approve.
  `PRAYER_TOWER_PUBLISH_MODE=direct` makes direct the default, but confirmation is **still** required.
- If someone commits in between (HTTP 409), the server re-fetches, replays and retries once.
- Commit messages are generated from the changes, for example `Add prayer request: Samuel Newton (additional)`, and end with `via prayer-tower MCP`.
- The token is never logged. Logs go to stderr only.

## Create a fine-grained GitHub token

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Resource owner:** `agimusa` (the org may need to approve it). **Repository access:** *Only select repositories* → `agimusa/prayer-tower`.
3. **Repository permissions:** **Contents: Read and write** and **Pull requests: Read and write** (Metadata: Read is added automatically). Nothing else.
4. Set an expiry date, generate the token, and copy it. Keep it out of git and out of any file you share.

## Claude Desktop

Edit `claude_desktop_config.json`:
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "prayer-tower": {
      "command": "node",
      "args": ["C:\\Users\\YOU\\code\\prayer-tower\\mcp\\dist\\index.js"],
      "env": {
        "GITHUB_TOKEN": "github_pat_REPLACE_ME"
      }
    }
  }
}
```

On Windows, escape backslashes in JSON (`\\`), or use forward slashes (`C:/Users/YOU/code/prayer-tower/mcp/dist/index.js`).
Restart Claude Desktop after editing.
For local mode, replace `GITHUB_TOKEN` with `"PRAYER_TOWER_REPO_PATH": "C:\\Users\\YOU\\code\\prayer-tower"`.

## Claude Code

```bash
# GitHub mode
claude mcp add prayer-tower --env GITHUB_TOKEN=github_pat_REPLACE_ME -- node C:/Users/YOU/code/prayer-tower/mcp/dist/index.js

# Local mode (edits your checkout; you commit/push)
claude mcp add prayer-tower --env PRAYER_TOWER_REPO_PATH=C:/Users/YOU/code/prayer-tower -- node C:/Users/YOU/code/prayer-tower/mcp/dist/index.js
```

Add `--scope user` to make it available in every project. Check it with `claude mcp list` or `/mcp`.

## Tools

| Tool | Purpose |
|---|---|
| `list_slides` | Slides in order: id, num, position, EN/TE titles, layout, active count |
| `get_slide {slide}` | One slide with all requests and ids. `slide` = id (`additional`), num (`7`) or title fragment |
| `search_requests {query, include_inactive?}` | Case-insensitive search over all text fields in EN and TE |
| `list_needs_review` | Requests with `te_status` `auto` or `needs_review` |
| `add_prayer_request {slide?, name?, note?, label?, detail?, items?, text?, children?, plain?, te_status?, position?}` | Add a request (default slide `additional`, default `te_status` `auto`). Returns the request and a text preview |
| `update_prayer_request {id, …fields, te_status?}` | Patch fields; `null` removes a field |
| `move_request {id, to_slide, position?}` | Move between slides |
| `mark_answered {id, testimony?}` | Status `answered` (hidden from site); testimony stored in `answer` |
| `archive_request {id}` / `restore_request {id}` | Hide / show again |
| `update_slide {slide, title?, theme?, glow?, timer_seconds?}` | Slide settings |
| `reorder_slides {order}` / `reorder_requests {slide, order}` | Reorder (must be a permutation) |
| `preview_changes` | Readable diff of pending changes and a line count |
| `publish {message?, direct?, confirm?}` | PR (default) or direct commit; local mode only reports |
| `discard_changes` | Drop the draft (GitHub mode). In local mode it explains how to `git checkout` |

**Resources:** `prayer://slides` (slide list), `prayer://slides/{id}` (one slide as JSON).
**Prompts:** `weekly_update {message}` turns a pasted WhatsApp message into requests, using real examples from the data.
`telugu_review` walks through machine-translated Telugu for a reader to confirm.

## Example conversation

> **You:** Add prayer request for Samuel Newton, Twinkle Amjala's elder brother: healing from diabetes complications and the infection in his right ankle.
>
> **Claude:** *(search_requests "Samuel Newton" → none)* *(add_prayer_request)* `name {en:"Samuel Newton", te:"శామ్యూల్ న్యూటన్"}`,
> `note {en:"(Twinkle Amjala's elder brother)", te:"(ట్వింకిల్ అమ్జాల గారి అన్నయ్య)"}`, `items [...]`, `te_status:"auto"`
> *(preview_changes)* Here's what will change: `[additional] + samuel-newton-k3x9 …`. Shall I publish? A PR is the default; I can also publish it live right away.
>
> **You:** Publish it live.
>
> **Claude:** *(publish {direct:true, confirm:true})* Committed to agimusa/prayer-tower@main: https://github.com/agimusa/prayer-tower/commit/…

## Data model (summary)

`data/prayers.json` is the single source of truth. `mcp/src/schema.ts` (zod) is the only definition of its shape.

- `Root { version: 1, updated_at, slides[] }`. Array order is display order.
- `Slide { id, num, title{en,te}, theme, glow, layout: "list"|"three-col", timer_seconds, columns?, add_panel?, requests[] }`
- `Request { id, status: active|answered|archived, visibility, source: manual|mcp|site, created_at, te_status: human|auto|needs_review, … }`
  - list rows: **either** `text` (a sentence, `**bold**` allowed) **or** `name` + optional `note`, `label`, `detail`, `items[]`
  - three-col (`children` slide): `name` (parents) + `children[]` + `items[]` (prayer points)
  - `answer { text, answered_at }` when answered with a testimony
- Only `active` requests are shown on the site. Telugu may be empty only when `te_status` is `needs_review`.
- New ids are `slug(name) + "-" + 4 random base36 chars`, for example `samuel-newton-k3x9`.

## Troubleshooting

- **Server exits immediately / "No configuration found"**: set `GITHUB_TOKEN` or `PRAYER_TOWER_REPO_PATH` in the client's `env` block.
- **401 / 403 from GitHub**: the token has expired, lacks Contents or Pull requests write access, isn't scoped to `agimusa/prayer-tower`, or is still waiting for org approval.
- **404**: check `PRAYER_TOWER_REPO`, `PRAYER_TOWER_BRANCH` and `PRAYER_TOWER_FILE`. Note: `data/prayers.json` only exists on `main` after the `feature/mcp-server` branch is merged, so GitHub mode needs that merge first (until then use local mode, or push the branch and set `PRAYER_TOWER_BRANCH=feature/mcp-server`).
- **"Direct publish … requires confirm: true"**: this is expected. Approve the preview, then Claude retries with `confirm: true`. Or use the default PR.
- **Validation errors** (for example "exactly one of `name` or `text`", "three-col requests require …"): the message names the field. Fix the call and retry. Nothing is written when validation fails.
- **Publish failed after replay**: someone changed the same request on the site in a conflicting way (for example deleted it). Run `discard_changes`, then redo the edit.
- **Nothing shows in Claude Desktop**: use an absolute path to `dist/index.js`, run `npm run build`, restart Desktop, and check its MCP logs (`%APPDATA%\Claude\logs\mcp*.log`).
- **Local mode, undo**: `git checkout -- data/prayers.json`.
