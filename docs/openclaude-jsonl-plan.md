# Plan: OpenClaude from BREEZ-APPS + JSONL transcripts

## Goal

Running OpenClaude against the **upper folder tree** (`BREEZ-APPS`, parent of this repo) should start the real OpenClaude CLI and persist turns as **JSONL** session logs, the same format TokenHouse can ingest for `getSessionEvents` (see `OPENCLAUDE_SESSIONS_DIR` and `~/.claude/projects` / `~/.openclaude/projects` layout).

## How JSONL is produced today

OpenClaude writes one file per session:

- Default config home: `~/.openclaude` (or `~/.claude` when legacy).
- Transcripts: `{configHome}/projects/<sanitized-cwd>/<sessionId>.jsonl`

The sanitized directory name depends on the **current working directory** when the CLI runs. Using the launcher with default `WORKDIR` set to `BREEZ-APPS` keeps all sessions under one stable project slug for that tree.

## Launcher

From this repo:

```bash
chmod +x scripts/openclaude-from-apps.sh   # once
./scripts/openclaude-from-apps.sh
```

Override workdir:

```bash
OPENCLAUDE_WORKDIR=/path/to/repo ./scripts/openclaude-from-apps.sh
```

Override binary:

```bash
OPENCLAUDE_BIN=/usr/local/bin/openclaude ./scripts/openclaude-from-apps.sh
```

## TokenHouse + member gateway

When using Anthropic-style routing through TokenHouse (see `tokenhouse-claude/platform/docs/openclaude-tokenhouse.md`), set at least:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787   # or nginx :8178
export ANTHROPIC_API_KEY=<tokenhouse-member-key-or-upstream-key>
```

Optional: `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` if the gateway rejects extra beta fields.

## TokenHouse server: spawning OpenClaude + JSONL

The platform server runs OpenClaude via `runCli` in `platform/apps/server/src/lib/cli-runner.ts`: it executes `openclaude --print --output-format stream-json` (or `node dist/cli.mjs` when `OPENCLAUDE_DIR` is set). Session continuity uses `--session-id` / `--resume` with the same UUID; OpenClaude appends **JSONL** transcripts under the config home’s `projects/<sanitized-cwd>/` tree.

To pin the cwd to your **upper repo tree** (e.g. `BREEZ-APPS`) so slugs and tool paths match that tree, set on the server:

```bash
export OPENCLAUDE_WORKDIR=/path/to/BREEZ-APPS
# Optional: explicit binary
# export OPENCLAUDE_BIN=/path/to/tokenhouse-claude/openclaude/bin/openclaude
```

`OPENCLAUDE_WORKDIR` overrides the legacy fallback where `OPENCLAUDE_SESSIONS_DIR` was also used as cwd.

## TokenHouse server: finding JSONL

The API searches, in order:

1. `~/.claude/projects/**/<sessionId>.jsonl`
2. `~/.openclaude/projects/**/<sessionId>.jsonl`
3. `OPENCLAUDE_SESSIONS_DIR` if set (same nested layout: child dirs containing `<sessionId>.jsonl`)

If you store transcripts only under a custom tree, set `OPENCLAUDE_SESSIONS_DIR` on the **server** to that root.

## Checks

After a session, confirm a new `.jsonl` under `~/.openclaude/projects/` (or `~/.claude/projects/`) for the cwd slug you used. Resume or analytics flows in OpenClaude read the same files.
