# Cyberboss Lite — Status

Read this file plus `git log` before starting a new session. Do not re-explore the
whole repo from scratch — this file and the recent commits are the source of truth
for what's done vs. pending.

## Repo / remotes

- Local path: `/home/keke/cyberboss-lite/app` (dev clone), deployed copy at
  `/srv/cyberboss-lite/app` (owned by the `cyberboss` Linux user).
- `upstream` = `https://github.com/WenXiaoWendy/cyberboss.git` (original, read-only reference).
- `origin` = `https://github.com/dovis2074053323-dotcom/cyberboss-lite.git` (vv's fork, public).
- Working branch: `lite`.
- Baseline commit (fork point from upstream): `373ab17d283f1e3b304a6a36e17e9e8d44f1acfc`.
- HEAD as of this session: see `git log -1` — three commits on top of baseline:
  1. `38fd226` — WIP: strip out-of-scope modules (deletions + dependency cleanup).
  2. `fa58dd9` — Rewrite composition root for the single-shot Lite runtime.
  3. `bc1b211` — Harden `.gitignore` against accidental credential/state commits.
- **Push to `origin/lite` is not yet done.** The original `.git-credentials` token
  couldn't create or push to the fork (403, insufficient scope). vv is creating a
  fine-grained PAT scoped to just this repo (Contents: Read/write) and will run the
  push manually from a terminal — the token is intentionally never passed through
  this chat/tool transcript. Until that push happens, `origin/lite` on GitHub may
  still be behind or absent; **the local `lite` branch in both paths above is the
  source of truth**, not GitHub, until confirmed otherwise.

## System-level setup (already done, verified)

- Linux user `cyberboss`: `useradd -m -d /home/cyberboss -s /bin/bash cyberboss`,
  password locked, no `.ssh`, not in `sudo` group.
- `/srv/cyberboss-lite/{app,workspace,state}`, owned `cyberboss:cyberboss`, mode 750.
- Global `claude` CLI installed via `npm install -g @anthropic-ai/claude-code`
  (`/usr/bin/claude`, world-executable) — deliberately *not* relying on
  `/home/keke/.local/bin/claude`, so `cyberboss` never needs access into keke's home
  beyond the one credential file below.
- Credential sharing: `cc-connect`-style symlink, **not** a fresh OAuth login.
  `CYBERBOSS_SHARED_CREDENTIALS_FILE` (env, must be set explicitly — no cross-user
  default is guessed in code) points at keke's `~/.claude/.credentials.json`.
  Minimal ACL: `setfacl -m u:cyberboss:x /home/keke` and `.../\.claude`, plus
  `u:cyberboss:r` on the credentials file itself. Verified `cyberboss` can read
  that one file and nothing else under `/home/keke`.
  - Known coupling: the shared access token needs keke's own regular CLI usage to
    keep refreshing it (cyberboss only has read access, can't self-refresh).
    Access token observed expiring ~24h out, refresh token ~6 days out, at the time
    of writing — not a blocker given daily usage, but worth a keepalive if that
    usage pattern ever stops.

## What actually got deleted (see commit `38fd226` for the full list)

Codex runtime adapter, Timeline integration/service + screenshot queue + shared
web-dashboard scripts, diary/sticker/vision-context/channel-file services + their
templates, the built-in dev tool host (`tools/`), cc-connect-style tool-approval
matching (`approval-command.js`), media receive/send/mime, `timeline-for-agent` and
`whereabouts-mcp` deps, and the old proactive-checkin subsystem
(`system-checkin-poller.js` + 4 config/queue stores + `system-message-service.js`)
— that subsystem hard-depended on the deleted Codex session store and is the direct
predecessor of the spec's Event-first Pulse, which replaces it wholesale later.

## What got rewritten (see commit `fa58dd9`)

- **`src/core/app.js`**: 2332 lines → ~250. Shrunk to exactly six concerns per the
  spec: weixin channel, sender gate, 10s bubble merge, turn gate, single claudecode
  runtime, reply send. `hostLock.tryAcquire()` is a **stub** (always
  acquires, never blocks) — the real `/run/agent-runtime` flock consumer is
  session-3 scope and was deliberately deferred (Morrow's side of that lock is a
  separate task, not part of these three sessions). Pulse/episode/memory/intentions
  have no code at all yet, not even stubs beyond that one hook point.
- **`src/adapters/runtime/claudecode/index.js`**: fully replaced. The old version
  was a persistent-process/IPC/resumable-session/tool-approval adapter shared with
  Codex's architecture — fundamentally the wrong shape for "one `-p` call per turn,
  no resumable thread." New version spawns one `claude` child process per turn via
  `child_process.spawn` (args array, no shell, so the message text is never
  interpolated into a shell string) and parses the final JSON result.
- **`src/core/inbound-turn.js`**: slimmed to text-only merge helpers (no
  attachment/image-batch logic — Lite only handles text).
- **`src/core/config.js`**: rewritten from scratch, only the fields Lite actually
  reads (see the file — it's short).
- New: **`src/core/sender-gate.js`** (bootstrap-capture + allowlist persistence,
  spec §5) and **`templates/system-prompt.txt`** (verbatim from spec §12).

Deleted as dead weight once the above landed: `thread-state-store.js` (built for
event-driven multi-thread status tracking that doesn't exist in a synchronous
single-shot call), `default-targets.js` (multi-workspace binding resolution, not
needed with one fixed sender/workspace), `stream-delivery.js` (957 lines built for
incremental streaming-delta delivery from a persistent process — a single-shot call
just returns one final string), `instructions-template.js` /
`shared-instructions.js` (persistent-thread "opening turn vs. refresh" instruction
mechanics), `templates/weixin-instructions.md` / `weixin-operations.md` (documented
the old bind/switch/model-switch command surface, all deleted).

**Left in place, untouched, not wired into `app.js`:** `src/services/reminder-service.js`
and `src/adapters/channel/weixin/reminder-queue-store.js`. This is the predecessor
of Future Intentions (spec §9), explicitly session-2 scope — not deleted because
rewriting it now would just mean redoing it next session, but also not connected to
anything so it can't run.

## The actual Claude invocation (runtime adapter)

One child process per turn:

```
claude -p "<merged turn text>" \
  --safe-mode \
  --tools "" \
  --no-session-persistence \
  --output-format json \
  --system-prompt "<contents of templates/system-prompt.txt, {{agent_name}} substituted>" \
  [--model <CYBERBOSS_CLAUDE_MODEL if set>]
```

Environment is rebuilt from scratch (not inherited) with only `PATH`, `LANG`,
`LC_ALL`, `TZ`, plus:
- `HOME=/home/cyberboss`
- `CLAUDE_CONFIG_DIR=<fresh mkdtemp dir under state/claude-cfg/>`
- `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`

`spawn()` is called with `timeout: config.claudeTurnTimeoutMs` (default 180000ms,
spec §5's hard cap) and `killSignal: SIGKILL`.

### Ephemeral config dir / transcript containment

Corrected mid-session from the original plan (scanning `~/.claude/projects` and
deleting after the fact was rejected as unreliable). Current scheme, empirically
verified:

1. Before the call: `fs.mkdtempSync(state/claude-cfg/cfg-XXXXXX)`, symlink only
   `.credentials.json` into it from the shared source file.
2. Run claude with `CLAUDE_CONFIG_DIR` pointed at that directory.
3. `finally`: `fs.rmSync(configDir, { recursive: true, force: true })`.

**Verified with two consecutive live runs**: `HOME/.claude` (the default fallback
Claude Code would otherwise use) stayed untouched — only the original credential
symlink, no new session/project/transcript files — while all transcript/session
data landed inside the ephemeral dir and was fully removed afterward.

**Gap found and closed**: if the process is killed mid-turn (crash/OOM/
`systemctl stop`), the `finally` never runs, leaving an orphaned config dir (with
its credential symlink) behind. `CyberbossApp.start()` now sweeps everything under
`claude-cfg/` before accepting messages — safe because nothing survives a restart
anyway (no session persistence, no long-lived thread to resume).

Minor, low-priority, not yet addressed: `claude` leaves an empty
`/tmp/claude-<uid>` directory per run (no content in it in testing, just an
IPC/lock scratch dir) — not cleaned up automatically. Fine to ignore or add a
`rm -rf /tmp/claude-$(id -u)` in the same `finally` later.

## Verified this session

- `npm run check` (syntax) clean on the full tree.
- Full `require()` resolution + `CyberbossApp` construction, both as `keke` (dev
  tree) and as the real `cyberboss` user against the real `/srv/cyberboss-lite`
  deployment.
- Two live `sendSingleTurn()` round-trips as `cyberboss`, hitting the ACL-restricted
  shared credentials file, replies matching the spec persona (short, casual, no
  tool/implementation claims).
- Sweep-on-start behavior (manually planted a stale directory, confirmed `start()`
  removes it before touching the WeChat loop).
- Cold-start OAuth smoke test (before the runtime rewrite, same credential-sharing
  approach): no login prompt, clean process environment (no Morrow/SSH/DB vars
  leaked in via `sudo -iu`).

## Not yet done / next session's job

This was the deliberate stopping point for session 1 — the pieces below are
implemented in code but **not exercised against real WeChat traffic**, because no
WeChat account is bound on this box yet:

1. `cyberboss login` (QR scan, binds a real WeChat account) — never run.
2. Sender-gate bootstrap flow (`src/core/sender-gate.js`) — unit-level logic only,
   not seen a real first message yet.
3. 10s bubble-merge + turn-gate behavior (`CyberbossApp.bufferInboundMessage` /
   `flushPendingBatch`) — not exercised against real rapid-fire WeChat messages.
4. Push `lite` to `origin` (blocked on vv's fine-grained PAT, see above).

Explicitly out of scope for session 1 and not started: Pulse, episode/context
rollover, long-term memory, Future Intentions — session 2/3 per the original spec.
Also not started: the Morrow-side host-wide flock (separate task in the Morrow
repo, not counted against these three sessions) — Cyberboss's `hostLock` stub is
ready to be swapped for the real consumer once that lands.

## For the next session

Read this file + `git log --oneline -5` on the `lite` branch. Pick up at: confirm
the push to `origin` landed, then run `cyberboss login`, verify sender bootstrap
against a real first message, verify 10s merge against real rapid WeChat bubbles,
then move into session 2 (episode state machine, token-budget rollover, long-term
memory, JSON Schema structured output, Future Intentions). Still targeting three
total `cc` sessions per the original spec.
