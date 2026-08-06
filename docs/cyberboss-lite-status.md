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
- Commits on top of baseline (see `git log --oneline` for the full, current list):
  1. `38fd226` — WIP: strip out-of-scope modules (deletions + dependency cleanup).
  2. `fa58dd9` — Rewrite composition root for the single-shot Lite runtime.
  3. `bc1b211` — Harden `.gitignore` against accidental credential/state commits.
  4. `b3b2d02` — Add session-1 status doc for handoff to the next cc session.
  5. Real-device verification session fix — plain-text system prompt + regression
     test (see "Real-device verification" section below for the SHA once committed).
- **Push to `origin/lite` landed.** vv's fine-grained PAT push succeeded at some
  point between the session-1 handoff and the real-device verification session
  (confirmed via `git ls-remote origin lite` matching local HEAD). `origin/lite` is
  the current source of truth alongside the local `lite` branch in both paths above;
  push after every commit and confirm local/origin SHAs match before ending a session.

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

## Real-device verification (post-session-1, before session 2)

All four items session 1 left unexercised were run against real WeChat traffic
and verified directly from process logs / state files (not inferred from vv's
reports alone — each claim below was cross-checked by reading
`/srv/cyberboss-lite/state/` after the fact):

1. **`cyberboss login`** — real QR scan with vv's daily WeChat account, confirmed
   by iLink (`confirmed` status), account persisted to
   `state/accounts/<accountId>.json`. Verified `accountId` (the bot's own
   `ilink_bot_id`) and `userId` (vv's `ilink_user_id`, the scanning account) are
   two distinct values — scanning authorizes vv as the allowed sender, it does
   **not** turn vv's personal WeChat into the bot identity.
2. **Sender-gate bootstrap** — first real inbound message captured `senderId` and
   persisted it to `state/sender-allowlist.json`; confirmed exactly one non-empty
   ID, no wildcard, no reply sent for that bootstrap message (per spec 五).
3. **allowlist + context_token persistence** — both survive a full process
   restart (confirmed: relaunching `start` after the system-prompt fix below
   loaded the persisted `allowedSenderId` directly, no re-bootstrap).
4. **10s bubble-merge** — four messages sent within the merge window produced
   exactly one `{"mode":"reply", ...}` runtime call in the log, not four.
5. **Passive receive/send** — real Claude turn round-tripped end to end
   (`isError:false`, `sendResult:"ok"`), confirmed in `state/start.log`.
6. `lite` pushed to `origin` (was already landed by the time this session
   re-checked; see "Repo / remotes" above).

**Bug found and fixed during verification:** `templates/system-prompt.txt` (copied
verbatim from the full spec in the `fa58dd9` rewrite) ended with an instruction to
"strictly follow the provided JSON Schema" — but session 1's runtime adapter
(`src/adapters/runtime/claudecode/index.js`) never passes a schema; it only
forwards `parsed.result` from `claude -p --output-format json` as plain WeChat
text. With no schema actually supplied, Claude improvised a JSON object
(`{"message": "..."}`) and that raw JSON string got sent to vv verbatim instead of
a normal reply. Fixed by changing the last line to instruct plain-text-only
output (no JSON/Markdown). Added `test/system-prompt-format.test.js`
(`node --test`) asserting the prompt doesn't request JSON/schema output and does
request plain text, plus a `looksLikeRawJsonReply` guard-test — this is a static
regression test against the prompt file, not a live-model test. Re-verified with
a real WeChat message after redeploying + restarting the listener: normal
plain-text reply confirmed.

**Important for session 2:** when real JSON Schema structured output is wired into
the runtime adapter (episode/memory/Future Intentions), the system prompt's
plain-text instruction must be restored to a schema-following instruction *at the
same time*. Don't change only the runtime and forget the prompt (or vice versa) —
that mismatch is exactly what caused the bug above.

Listener was stopped cleanly (`SIGTERM`, graceful exit) at the end of this
session — there is no `systemd` unit and no host-wide flock yet, so nothing should
be left running as an unmanaged PPID=1 process between sessions. To run it again:
`sudo -u cyberboss setsid /srv/cyberboss-lite/state/run-start.sh > /srv/cyberboss-lite/state/start.log 2>&1 < /dev/null &` (disown it), or the equivalent `run-login.sh` for
re-login. Both helper scripts live in `/srv/cyberboss-lite/state/` (not in git —
they're deployment-side launch scripts, not app code) and already export
`CYBERBOSS_STATE_DIR` / `CYBERBOSS_SHARED_CREDENTIALS_FILE`.

**Operational note from this session:** avoid `sudo -iu <user> bash -c '...'` with
a multi-line script and trailing positional args — `sudo -i` reconstructs the
command by rejoining argv into a new string for the target's login shell, which
loses the original quoting. That hazard, not any external process, deleted
`/srv/cyberboss-lite/app/bin/cyberboss.js` mid-session (silently restored from the
dev clone; no other files were affected, confirmed via full re-diff). Prefer
`sudo -u <user> <script-file>` or `sudo -u <user> bash -c '<single-line-script>'`
(no `-i`) instead.

## For the next session

Read this file + `git log --oneline -5` on the `lite` branch. Session 1's three
real-device verification items (login, sender bootstrap, 10s merge) are done —
move into session 2: episode state machine, token-budget rollover, long-term
memory, JSON Schema structured output, Future Intentions. When structured output
lands, restore the schema-following system prompt (see "Important for session 2"
above) and delete/replace the plain-text assertions in
`test/system-prompt-format.test.js` accordingly. Still targeting three total `cc`
sessions per the original spec (this was session 1 + a real-device verification
pass, not a new session).
