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

## Session 2 (episode / memory / Future Intentions / structured output)

Session 2's actual spec text lives at `docs/session-2-spec.md`, committed verbatim
(`a64a74d`) after a real gap was found: this status doc's session-1 section cited
"spec §5/§9/§12" as if a numbered document existed in the repo, but it never did —
the spec had only ever been discussed in chat. `docs/session-2-spec.md` is now the
one committed, citable source for everything below; this section records what was
actually built against it, plus every place the spec left a gap and how it was
filled.

Commits, in the order spec §10 required (`git log --oneline a64a74d..434099c`):

1. `a64a74d` — session-2 spec saved verbatim.
2. `bdd0da3` — removed 13 dead test files left over from the session-1 rewrite
   (Codex adapter, timeline, stickers, tool-host, image handling, old per-thread
   dispatch) — all either failed `require()` or exercised deleted `CyberbossApp`
   methods. `node --test` went from 26 pass / 37 fail to 26/26 green, needed as a
   clean baseline before adding session-2's own tests.
3. `9d76800` — JSON Schema structured output wired into the runtime adapter.
4. `05a96d8` — `current-state.json` / open-loops storage + episode state machine.
5. `e0b3847` — two-tier long-term memory store.
6. `534cccb` — Future Intentions store.
7. `cdd5cdc` — context assembly + transactional turn coordinator wired into
   `app.js`; deleted `reminder-service.js` / `reminder-queue-store.js` (both
   already broken, depending on the deleted `default-targets.js`).
8. `434099c` — found and fixed a real validation gap (below), filled the
   remaining spec §9 required tests.

### JSON Schema & runtime (spec §3)

Verified against the installed CLI (2.1.223) before writing any code:
`claude --help` lists a real `--json-schema <schema>` flag. A live `-p` call with
`--json-schema` + `--output-format json` returns the parsed object under
**`structured_output`** in the response envelope — `result` is the same content
re-serialized to a string, not a different/older shape. `src/adapters/runtime/claudecode/index.js`
now reads `structured_output` and no longer exposes any `replyText`-shaped field
at all, which structurally forecloses the session-1 bug class (schema requested,
never sent, model improvises raw JSON to WeChat).

**There is no `--max-turns` flag on this CLI version** — the spec's "single call,
max-turns=1" intent is satisfied by process-spawn discipline (`app.js` spawns
exactly one `claude` process per merged WeChat batch), not a CLI flag. The
response's own `num_turns` is consistently `2` even for one logical call — an
internal detail of how the CLI validates structured output (looks like a
tool-call round-trip under the hood) — and isn't meaningful here.

`src/core/result-schema.js` defines both the JSON Schema handed to the CLI and a
**hand-written JS validator**, deliberately not a generic engine like ajv — the
result shape is small and fixed, and this repo already keeps dependencies
minimal (session-1 note). The CLI's own schema enforcement is defense in depth
only; the JS validator is the actual gate before any state mutation, per spec
§3's "非法结构不应用任何状态变更".

System prompt's last line is restored to the schema-following instruction;
`test/system-prompt-format.test.js`'s assertions were inverted (and a new
regression test added tying the prompt's claim directly to the adapter actually
passing `--json-schema`, so the two can't drift apart again in either direction).

### Storage & data structures (spec §2)

All under `stateDir` (`CYBERBOSS_STATE_DIR`, `/srv/cyberboss-lite/state/` in
deployment), atomic temp-file + rename writes via `src/core/json-store.js`,
fail-closed on corruption (`StateCorruptionError`, file left untouched, never
silently reset). `CyberbossApp.start()` now loads every active store once at
boot and calls `process.exit(1)` with a FATAL log on corruption instead of
accepting WeChat traffic against unknown state.

- **`current-state.json`** (`src/core/current-state-store.js`): the 5 spec
  fields *and* `openLoops` in one file — the spec lists only one storage file
  for both, and separately restricts what the model's `statePatch` may touch to
  the 3 subjective fields (`currentActivity`/`expectedReturnAt`/`recentMood`).
  **Interpretation call**: `lastUserMessageAt`/`lastAgentMessageAt`, although
  named as schema-legal `statePatch` keys in the spec, are never actually taken
  from the model's patch — the coordinator always sets them from real observed
  event timestamps (actual inbound receipt / actual confirmed outbound send).
  Trusting a model's clock claim over an observed fact would contradict the
  whole system's "don't treat guesses as fact" framing. Open loops are mutated
  only via `addLoop`/`resolveLoop`, never through a patch.
- **`memories.json`** (`src/core/memory-store.js`): core (max 12, always fully
  injected) / contextual (max 30, top-8 scored) tiers. Dedupe is exact-
  normalized-fact-match within the same category+tier — no fuzzy/embedding
  matching, per spec's explicit "不引入向量数据库" and the general "保守型"
  framing. `forget` marks `superseded`; `purgeSuperseded` physically removes
  after 30 days and never touches `active` records. Contextual scoring is
  additive and dependency-free: tag match in current message (+3), tag match in
  an open loop (+2), crude bigram overlap between fact and current message
  (+2), used/created within the last 3 days (+1) — sorted, capped at 8 items,
  budgeted at ~900 estimated tokens combined with core.
- **`intentions.json`** (`src/core/intentions-store.js`): `reminder` /
  `check_in` / `resume_topic`. Per-type rules the schema's shape check can't
  express live here: reminder needs a parseable future `dueAt`; check_in needs
  a parseable `dueAt` within 48h; resume_topic never schedules (`dueAt` always
  `null`) and defaults `expiresAt` to +7 days when the model doesn't supply one.
  **Interpretation call**: reminder defaults `expiresAt` to `dueAt`+24h grace —
  not specified by the spec, but without it an unfired reminder (nothing sends
  yet this session) would sit `pending` forever, silently eating into the cap
  of 10. **Interpretation call**: `cancelOnInbound` defaults to `false` for
  `reminder` and `true` for `check_in`/`resume_topic` — the spec's "用户重新
  出现...时自动取消" is a general limit without a per-type carve-out, but a
  reminder is tied to a real `dueAt` (a concrete task), not to user absence, so
  the user texting about something else shouldn't cancel a medicine reminder
  due in 20 minutes; check_in and resume_topic both exist *because* the user
  was quiet, so once they're not quiet the premise is gone. `check_in` cancels
  silently on any real inbound message (before that turn's model call, in
  `prepareTurn`); `resume_topic` instead gets injected once into context and
  resolved as part of that turn's successful apply, per spec's "一次性" /
  "用户下次入站时注入" framing.
  Execution interface (`selectDueForExecution` + `executeDueIntentions`) is
  implemented and unit-tested with a fake clock and fake lock, but **nothing in
  `app.js` calls it** — no poller, no cron, no in-process `setInterval`, per
  spec's explicit scope exclusions. Real sending stays behind
  `CYBERBOSS_ENABLE_SCHEDULED_INTENTIONS` (default `false`) until session 3
  wires the host-wide try-lock.
- **`episodes/current.json` + `episodes/archive/<id>.json`**
  (`src/core/episode-store.js`): idle rollover (6h, condition A) and budget
  rollover (soft 3500 / hard 5000 estimated tokens — `ceil(UTF-8 bytes / 3)` —
  condition B). `rolloverEpisode()` is idempotent against the **on-disk**
  `rolloverVersion`, not the caller's in-memory copy — checking a caller's own
  stale copy against itself would never catch a duplicate call, which is
  exactly the scenario the guard exists for. Hard-limit-without-handoff trims
  to the last 4 merged turns via `trimToLastTurns`, which counts *user-role*
  messages rather than assuming clean user/assistant pairing (a silent turn —
  model chose not to reply — only appends one message).
  **Interpretation call**: the spec's episode shape has no carry-context field,
  and rollover carry is explicitly "一次性" (one-shot), so `loadCarryContext`
  infers "first turn since rollover" from `messages.length === 0` and looks up
  the most recently archived episode **by file mtime** rather than adding a
  pointer field — zero schema extension. That historical-archive read is
  deliberately best-effort (a corrupt/unreadable archive entry just means no
  carry offered this turn, not a startup failure) — distinct from the
  fail-closed guarantee, which is reserved for the 4 *active* state files.

A real bug was caught by testing, not inspection: `readJsonStore`'s envelope
fields (`schemaVersion`/`updatedAt`) were leaking into the in-memory domain
object every store's `load()` returned. Fixed by stripping them before return
in every store.

### Transactional coordinator (spec §8)

`src/core/turn-coordinator.js`, split into two phases:

- **`prepareTurn`** commits whatever is true independent of this turn's model
  output — elapsed real time (idle rollover) and "the user is here now"
  (check_in reappearance cancellation) — immediately, before the runtime call
  even happens. It also assembles the bounded context text
  (`src/core/context-assembler.js`, spec §7's exact field order: MODE/NOW, core
  memory, contextual memory, current state, open loops, prior-episode carry
  context, current episode live dialogue, pending resume_topic, this turn's
  merged messages, rolloverRequested — never full history).
- **`applyTurn`** does 校验→发送reply→statePatch→loops→memory→intentions→
  handoff/episode, gated entirely on the structured result validating *and* the
  reply actually being delivered. **Interpretation call**: on send failure, the
  *entire* turn's downstream effects void — not just `lastAgentMessageAt` and
  the episode append that the spec calls out explicitly, but statePatch,
  memory, loops, and intentions too. The spec's "其他...变更也暂不应用" is a
  little open-ended about how far "other" reaches; full rollback was chosen as
  the simplest, most testable reading, and it's the only one consistent with
  "中途失败不得形成半套状态" (one transaction, not a partial one) — anything
  narrower would need its own line to draw, and the spec doesn't draw one.

### Test results

`node --test`: **107/107 passing**. `npm run check` (syntax): clean. Mapping
spec §9's 16 required items to what actually covers them:

1. Schema rejects extra fields/wrong types — `test/result-schema.test.js`
2. Plain reply never becomes a raw JSON send — `test/claudecode-runtime.test.js`
   (adapter has no `replyText`-shaped field at all) + `test/system-prompt-format.test.js`
3. 6h idle rolls over exactly once — `test/turn-coordinator.test.js`
4. Soft limit produces handoff + rolls over — `test/turn-coordinator.test.js`
5. Hard limit trims correctly without a handoff — `test/turn-coordinator.test.js`
6. 50 consecutive turns don't grow context linearly — `test/episode-store.test.js`
7. Memory without this-turn sourceQuote is rejected — `test/result-schema.test.js`
8. Duplicate memory doesn't add a new record — `test/memory-store.test.js`
9. User correction marks a memory superseded — `test/memory-store.test.js`
10. Intention per-turn-1 / pending-cap-10 — `test/result-schema.test.js` +
    `test/intentions-store.test.js`
11. Reminder without an explicit user request is rejected —
    `test/result-schema.test.js` (the sourceQuote-verbatim gap found and fixed
    in `434099c`) + `test/intentions-store.test.js` (dueAt validation)
12. resume_topic injected on next inbound — `test/turn-coordinator.test.js`
13. Episode/memory/state/intentions all recover after restart —
    `test/turn-coordinator.test.js`
14. Scheduled intentions default off — `test/config.test.js` +
    `test/intentions-store.test.js`
15. Ephemeral Claude config dir / transcript isolation — unchanged code path
    from session 1 (only `buildArgs`/`parseResult` were touched this session,
    not the `mkdtempSync`/symlink/`rmSync`-in-`finally` flow); re-verified live
    as part of item 16 below, same as session 1 originally verified it.
16. Real WeChat structured-reply round-trip — **done**, see below.

### Real WeChat verification (done)

`/home/keke/cyberboss-lite/app` (HEAD `b7ad9e5` at the time) was mirrored to
`/srv/cyberboss-lite/app` via `rsync -a --delete --exclude=node_modules
--exclude=.git` (no `package.json` changes this session, so no `npm install`
needed), owned back to `cyberboss:cyberboss`. `npm run check` and `node --test`
(107/107) both re-run clean as the `cyberboss` user on the deployed copy before
starting anything. Listener started via the existing `state/run-start.sh`,
`setsid`'d and detached (confirmed `PPID=1`, own session) — no systemd, matching
spec. Existing account/sender-allowlist/context-token from session 1's
real-device pass were reused as-is; no re-login, no re-bootstrap.
`CYBERBOSS_ENABLE_SCHEDULED_INTENTIONS` was confirmed unset in `run-start.sh`
(defaults `false`).

Four rounds tested live against vv's real WeChat account, all passing:

- **A — plain structured reply**: `我好困。` → natural plain-text reply, no raw
  JSON, exactly one `"mode":"reply"` log line, `rolloverReason:"none"`
  (structured result validated and applied cleanly, not the
  `invalid_structured_result` path).
- **B — memory write**: `记住，我不喜欢把普通聊天变成一堆建议。` → exactly one
  new record in `memories.json`, `sourceQuote` exactly equal to what was
  typed — self-verifying, since a non-verbatim quote would have failed
  `validateStructuredResult` and the memory would never have been persisted at
  all. `recentMood` (transient) landed in `current-state.json`, not in the
  memory record — clean separation per spec §5's "不保存短暂情绪".
- **C — current state / open loop**: `我现在在测试 Cyberboss，测试完还要整理
  结果！` → `current-state.json.currentActivity` set correctly, no extra
  fields, valid `schemaVersion`/`updatedAt` envelope (atomic write). The model
  chose not to open a loop for "整理结果" (judged not to rise to a trackable
  commitment) — acceptable since the spec's acceptance criterion is state *or*
  loop, not both.
- **D — restart recovery**: listener stopped with `SIGTERM` (clean exit,
  confirmed process gone), restarted fresh (new PID, new Node process), then
  asked "刚才在做什么？". Reply continued the same conversation in tone and
  content — confirmed from `episodes/current.json`: **same `episodeId`
  post-restart**, all 4 turns (8 messages) from before *and* after the restart
  present in one continuous transcript, loaded purely from disk with no Claude
  session to resume from (`--no-session-persistence` was already true before
  session 2). `memories.json` and `current-state.json` both survived intact.
  No sender-bootstrap re-trigger — `allowedSenderId` loaded from
  `sender-allowlist.json` at boot, reply sent normally.

Known limitation surfaced by real traffic (not a defect, a scope note): none of
A–D exercised `soft`/`hard` episode-budget rollover or an actual `reminder`/
`check_in` intention creation — real conversations don't hit ~3500 estimated
tokens in 4 short turns, and the test plan deliberately excluded scheduled-
intention proactive sending (stays off, spec §6). Both paths are covered by
`test/turn-coordinator.test.js`/`test/intentions-store.test.js`'s synthetic
tests, just not yet by live traffic — worth a longer live session in session 3
once Pulse/Tasker add more natural volume.

## Credential ACL: root cause and fix (post-session-2, before session 3)

Found live: real WeChat traffic stopped getting replies after the listener had
been manually restarted following an idle period. Not a crash, not a WeChat-side
issue — the runtime adapter's `claude` child process was returning
`"result":"Not logged in · Please run /login"` (`is_error:true`) on every turn.

**Root cause.** The credential-sharing design (see "System-level setup" above)
grants `cyberboss` a read-only **file** ACL entry (`u:cyberboss:r`) on keke's
`~/.claude/.credentials.json`. That grant is only as durable as the inode it's
attached to. keke's own `claude` CLI usage refreshes its OAuth token by writing
a **new** file (temp-file + rename — confirmed via `stat`: `Birth` timestamp
equals `Modify` timestamp, i.e. a fresh inode, not an in-place edit) roughly
every ~24h per the original observed expiry window. A fresh inode carries none
of the ACL entries set on the one it replaced, so `cyberboss`'s read grant
silently disappears on every refresh — with no error at refresh time; the
failure only surfaces later, as "Not logged in" on the next WeChat turn.

**Why not a directory-level default ACL.** The obvious durable fix — a
`default:` ACL on `~/.claude` so any new file born there automatically inherits
`u:cyberboss:r` — was rejected. A directory default ACL applies to *every* file
and subdirectory subsequently created under `~/.claude`, not just
`.credentials.json`; that widens `cyberboss`'s reach to whatever else keke's
own Claude Code usage happens to create there (`settings.local.json`, todos,
shell snapshots, project state, future files not yet invented). "No broader
than the one file we actually need" was the explicit constraint, and a default
ACL structurally cannot honor it — the access surface would grow every time
keke's own tooling adds a new file to that directory, with no one deciding
that expansion happened.

**Fix actually shipped: minimal sudo + one fixed script, not a broader grant.**

- `deploy/cyberboss-ensure-claude-credential-acl` (installed to
  `/usr/local/sbin/…`, `root:root`, `0755` — not writable by `keke` or
  `cyberboss`): takes zero arguments, hardcodes the one target path, refuses
  symlinks, confirms the target is a regular file, and does exactly one thing:
  `setfacl -m u:cyberboss:r-- -- /home/keke/.claude/.credentials.json`. Never
  reads or prints the file's contents.
- `deploy/cyberboss-credential-acl.sudoers` (installed to
  `/etc/sudoers.d/cyberboss-claude-acl`, `root:root`, `0440`, validated with
  `visudo -cf` both before and after install): grants `cyberboss` — and only
  `cyberboss` — password-less `sudo` to run that one script as `keke`. Note
  sudoers' own argument-matching only restricts *which command* may run, not
  argument count for a bare (no-args-listed) entry — a sudoers rule alone does
  **not** stop `cyberboss` from invoking the script with extra arguments. The
  script's own `if [ "$#" -ne 0 ]` check is what actually enforces
  zero-argument-only; this was verified directly (`sudo -u cyberboss sudo -u
  keke .../cyberboss-ensure-claude-credential-acl extra-arg` reaches the
  script and is rejected by it with exit 2, not blocked by sudo itself).
- `src/adapters/runtime/claudecode/index.js`: `sendSingleTurn` now runs this
  preflight (`sudo -n -u keke /usr/local/sbin/cyberboss-ensure-claude-credential-acl`)
  before every `claude` invocation. **Fail closed**: if the preflight itself
  fails, `claude` is never started for that turn. If `claude` still comes back
  with an explicit "not logged in"/"please run /login" signal (checked against
  both the process's stdout when it exits non-zero, and a successfully-parsed
  `is_error:true` result — the CLI has been observed to exit `1` while still
  emitting a valid JSON envelope on stdout, so both paths must be checked), the
  preflight is re-run and the turn is retried **exactly once** — no unbounded
  retry loop. Logging (`console.log`/`console.error`, existing `[cyberboss]`
  prefix convention) records only preflight success/failure and the retry
  decision, never file contents, tokens, or the credential path's contents.
  Install/reproduce steps: `docs/credential-acl-install.md`.
- Bundled in the same fix: `runClaudeProcess` now spawns `claude` with
  `stdio: ["ignore", "pipe", "pipe"]` instead of the implicit `"pipe"` default
  for stdin. Nothing was ever writing to the child's stdin, so every single
  turn was stalling ~3s on the CLI's own "no stdin data received" timeout
  before proceeding — unrelated to the ACL bug, but found while reproducing it
  and trivial to fix in the same function.

**Verified.** `npm run check` and `node --test` (107/107) both clean on the dev
tree and, after `rsync`, on the `cyberboss`-owned `/srv/cyberboss-lite/app`
deployed copy. Sudo chain confirmed end-to-end as `cyberboss`:
`u:cyberboss:r--` present on the credential file after running the preflight
through `sudo`; `cyberboss` still cannot `ls` or read anything else under
`~/.claude` (no default ACL exists anywhere on the path — confirmed via
`getfacl` on both `~/.claude` and `~`, only the pre-existing `--x`
traverse-only entries remain). One real round-trip against vv's live WeChat
account through the rebuilt listener came back `isError:false` with the
`[cyberboss] acl preflight ok` log line preceding it. Listener stopped
(`SIGTERM`, graceful exit confirmed) after verification — no systemd unit
exists yet, same as every prior session.

**Known limitation, unchanged by this fix:** the shared-credential design still
structurally depends on keke's own regular `claude` CLI usage to keep the
underlying OAuth token refreshed — `cyberboss` has read-only access and cannot
refresh it itself. This fix only makes sure `cyberboss` keeps *read access to
whatever the current token is*; if keke's own usage pattern ever stops for long
enough that the refresh token itself expires (~6 days observed at the original
setup), no ACL fix restores a token that no longer exists. Not addressed here,
same as the original "System-level setup" note.

**Deliberately not added: an ACL heartbeat.** No poller, no timer, no
proactive re-grant when nothing is happening. The existing per-turn preflight
in `sendSingleTurn` already covers every path that calls `claude` — normal
replies today, and Pulse / scheduled intentions once session 3 wires them in,
since all three go through the same runtime adapter. Session 3 adds exactly
one more preflight call, at systemd unit start (before the bridge loop begins
accepting messages) — still not a recurring heartbeat, just one more
call site of the same synchronous check.

## Session 3 (real host lock, bubble-merge retune, systemd, Pulse) — done

No written spec doc for session 3 exists (unlike session 2's committed
`docs/session-2-spec.md`) — scope came directly from vv in chat, in two
passes: an initial ordered list (host lock → WeChat-turn blocking wait →
Pulse/intentions non-blocking try-lock → status.json observation-only →
bubble-merge retune → systemd → startup ACL preflight → crash/restart
verification → Pulse + Tasker → flip the flag), then — after Pulse/Tasker
came back with no real spec anywhere — a follow-up message giving Pulse a
concrete minimal scope and explicitly deferring Tasker observation to a
documentation-only note. Everything in that list, including the final flag
flip and live acceptance pass, is done — see "Final live acceptance" and
"Two real issues found during this final pass" below for what live traffic
actually surfaced (both fixed, neither was a lock/Pulse defect).

### Real host lock (spec: Morrow's `docs/agent-runtime-lock.md`)

`src/core/host-lock.js` — a direct CommonJS port of Morrow's
`flock -F -w <timeoutSec> -E 42 <lockfile> /bin/cat` + stdin-sentinel-handshake
protocol (that doc is the one source of truth for the mechanism; this side
didn't redesign anything, just implemented the already-agreed "Cyberboss
session 3 接入协议" section of it). Two entry points instead of Morrow's one,
because the two call sites have genuinely different semantics:

- `acquireHostLock({ lockDir, kind, timeoutMs })` — blocking with a real
  timeout (kernel `alarm(2)` via `flock -w`, not polling). Used by real WeChat
  turns (`flushPendingBatch` in `app.js`): "可以等待锁，超时后失败" — Morrow
  might be mid-turn, nobody is staring at a WeChat spinner the way Morrow's
  chat UI is, so it's fine to wait, just not forever
  (`config.hostLockWaitMs`, default 60s, vs. Morrow's own 45s chat-facing
  wait). Failure (`HostLockBusyError`/`HostLockSystemError`) is caught by the
  same existing `catch` block every other turn failure already goes through —
  no new failure path, typing indicator still stops, turn gate still releases.
- `tryAcquireHostLock({ lockDir, kind })` — non-blocking (`-w 0`), used
  wherever the contract is "never wait, never preempt Morrow, just skip this
  tick if busy." Both `HostLockBusyError` and `HostLockSystemError` normalize
  to `{ acquired: false }` here — the caller only needs a boolean, busy is the
  expected/common case and a system error just gets an extra `console.error`
  for ops visibility. This is exactly the `tryLock` shape
  `executeDueIntentions` already had fake-clock/fake-lock tests locked onto
  from session 2 — the real implementation slots in with no interface change.

`status.json` shape matches Morrow's 6 fields exactly, `owner: "cyberboss"`.
Confirmed both sides can never disagree about what "the lock" is — same file,
same protocol, no code sharing needed because the protocol doc is language-
agnostic by design.

**Verified against the real deployed system, not just tmpdir unit tests**:
`cyberboss` really can flock `/run/agent-runtime/claude.lock` (already true
before this session, provisioned when Morrow wired its side in — see
`[[cyberboss-morrow-shared-claude]]`-adjacent work); ownership/mode on the
real path (`root:agent-runtime 2775` dir, `root:agent-runtime 664` lockfile)
confirmed read-only (deliberately did **not** `rm -rf`/recreate the real
tmpfs path from a test — that path is live production shared with Morrow,
recreating it mid-test would be destructive to whatever either side is
actually doing at the time). `test/host-lock.test.js`'s two real-path tests
are read-only assertions plus a try-lock probe that gracefully treats "busy
because Morrow itself is running this test right now" as an observed-not-
failed outcome (self-referential: the process running the test suite may
itself be the Morrow session holding the lock).

### app.js wiring

- `flushPendingBatch`: lock acquisition moved inside the existing `try`
  block (was an unconditional stub-acquire before the `try`). A lock
  failure — busy-after-timeout or a system error — is indistinguishable from
  any other turn failure to the rest of the function: same `catch`, same
  typing-stop, same turn-gate release, same `logPayload.isError = true`. Only
  addition is a more specific `console.error` line distinguishing
  `HostLockBusyError`/`HostLockSystemError`/other for ops readability.
- `runDueIntentionsCheck()` (new method): the actual, real, non-Claude-
  calling caller of `executeDueIntentions` — loads `intentionsStore`, calls
  it with `tryAcquireHostLock` as `tryLock` and a plain WeChat `sendText` as
  `sendFn`, saves the resulting state back. Gated by
  `config.enableScheduledIntentions` (still `false`). **Nothing calls this
  method yet** — see "Pulse + Tasker observation" below for why; the method
  itself is complete, tested indirectly via `executeDueIntentions`'s own
  session-2 fake-lock tests plus this session's real `host-lock.js`.
  **Interpretation call**: `sendFn`'s message text is
  `intention.reason` (+ `\n` + `intention.context` if present) — `sendFn`
  must be plain delivery, never a second Claude call (spec §6: "定时执行不得
  递归创建新 intention、memory 或 handoff"), so the outbound text has to come
  straight from data the model already wrote at creation time; `reason` is
  the closest thing to "what to say" without a rephrase call.

### Bubble-merge retune: idle-debounce + hard cap, replacing the flat 10s

`config.inboundIdleDelayMs` (default 1800) / `config.inboundMaxWaitMs`
(default 3500) replace the old single `inboundMergeWindowMs` (was a flat
10000 for every batch, including a single lone message). New behavior in
`bufferInboundMessage`/`scheduleMergeFlush`/`triggerMergeFlush`:

- `idleTimer` resets on **every** message in the batch (debounce — keep
  waiting while bubbles are still arriving).
- `maxWaitTimer` is armed **once**, on the first message of a new batch, and
  never reset (hard cap — a steady trickle can't push the flush out
  indefinitely).
- Whichever fires first wins; the other is cleared so there's never a double
  flush.
- A single lone message now merges in ~1.8s, not a flat 10s.

**Explicitly untouched, per vv's instruction**: the in-flight
`pendingMessages` recursive-flush path (messages arriving while a turn is
already running skip merge timers entirely and flush immediately once the
gate frees — spec 四) — `bufferInboundMessage`'s early-return branch when
`turnGateStore.isPending(...)` is true still does exactly what it did before,
verified by a dedicated test (`test/app-bubble-merge.test.js`, "正在跑的 turn
期间到达的消息不设任何合并计时器").

### systemd

`deploy/cyberboss.service`, installed to `/etc/systemd/system/cyberboss.service`,
`EnvironmentFile=/etc/cyberboss.env` (root:root 0600, holds
`CYBERBOSS_STATE_DIR`/`CYBERBOSS_SHARED_CREDENTIALS_FILE`/
`CYBERBOSS_ENABLE_SCHEDULED_INTENTIONS=false`, mirrors the pre-existing
`run-start.sh`'s two vars plus the explicit off-switch). `User=cyberboss`,
`WorkingDirectory=/srv/cyberboss-lite/app`, `Restart=always`.
**`NoNewPrivileges=false` is required, not optional** — the credential-ACL
preflight runs `sudo -n -u keke ...`, and `sudo` is a setuid-root binary;
`NoNewPrivileges=true` would make the kernel refuse that privilege gain
outright, silently breaking every turn for the wrong reason (looks like an
ACL problem, is actually a systemd sandboxing problem). Caught this before
it ever shipped, not after a live failure — mirrors Morrow's own unit file,
which has the same flag for a related reason (its own sudo-gated tool
approvals). `MemoryHigh=300M`/`MemoryMax=450M` are a first-pass conservative
estimate given the box's real headroom at write time (~986M "available", per
`free -h`, with Morrow alone able to spike to 900M) — not load-tested against
real sustained WeChat traffic yet.

Startup ACL preflight: `CyberbossApp.start()` now calls the same
`runAclPreflightOrThrow()` the per-turn runtime adapter already used,
**before** `resolveAccount()`/the polling loop — fail-closed with
`process.exit(1)` on failure, same pattern as the existing store-corruption
fail-closed exit right above it. Not a new mechanism, exactly what the
session-2 status doc's "For session 3" note already called for: one more
call site of the existing check.

Installed and verified live: `systemctl enable --now cyberboss.service`
came up clean (`acl preflight ok` → `bootstrap ok` → `bridge loop started`),
deployed copy synced via the same `rsync -a --delete --exclude=node_modules
--exclude=.git` + `node_modules` rsync (no dependency changes this session)
pattern session 2 used, `npm run check` + `npm test` (125/125, 1 skipped —
the real-path try-lock test skips when the runner itself has no passwordless
sudo, e.g. when run as `cyberboss`) both clean as `cyberboss` on
`/srv/cyberboss-lite/app` before starting anything.

**Crash-safety, verified two ways**:
1. Isolated (`test/host-lock.test.js`, tmpdir-scoped, mirrors Morrow's own
   `claude-lock.test.js` fixture pattern exactly): a real independent OS
   process (`test/fixtures/host-lock-holder-sim.js`) acquires the lock,
   prints its holder pid, hangs; the test `kill -9`s the *simulator* process
   (not the holder — the holder is a child `flock`/`cat` process spawned by
   the simulator, exactly mirroring "Cyberboss's real main process getting
   OOM-killed"), confirms the holder pid exits on its own within 3s (kernel
   closing the inherited stdin pipe write-end → `cat` reads EOF → exits →
   `flock` releases), then confirms a fresh `acquireHostLock` succeeds
   immediately after.
2. Live, against the actual systemd-managed process on the real
   `/run/agent-runtime` path (deliberately **not** while it held the lock —
   see "Real host lock" above for why the live shared file wasn't used for
   the kill itself): `sudo kill -9 <MainPID>` while `cyberboss.service` was
   idle, confirmed `Restart=always` brought up a fresh PID within the
   `RestartSec=5` window, and confirmed `current-state.json`,
   `episodes/current.json` (**same `episodeId`**), `intentions.json`, and
   `sender-allowlist.json` (**no re-bootstrap**) were all byte-for-byte
   identical before and after — the fail-closed store-loading path from
   session 2 (`loadAllStoresOrExit`) handled the restart with zero special
   handling needed.

### Pulse — implemented, minimal scope only (vv's follow-up spec)

vv gave a concrete, deliberately narrow spec in chat (no committed spec doc —
same as the rest of session 3's ordering) after the "still open" note above:
Pulse in this stage drives Future Intentions only, **not** an autonomous
"reach out just to chat" agent heartbeat.

- 60s tick (`config.pulseIntervalMs`, `CYBERBOSS_PULSE_INTERVAL_MS` override
  for tests — production default matches the spec exactly).
- The tick itself never calls Claude. It only calls the already-wired
  `runDueIntentionsCheck()` (see above), which was already a true no-op —
  zero lock attempts, zero sends, zero model calls — whenever nothing is due
  (`executeDueIntentions`'s `due` array is empty, so its `for` loop never
  runs). No separate "is anything due" pre-check was needed; the existing
  session-2 code already had this property.
- Uses the same non-blocking `tryAcquireHostLock` `runDueIntentionsCheck()`
  already wired in: lock free → sends; Morrow or another Cyberboss path busy
  → that intention just stays `pending`, picked up again next tick.
- No double-send: `executeDueIntentions` only marks an intention `resolved`
  after a successful `sendFn`, and `runPulseTick()` adds a reentrancy guard
  (`pulseTickInFlight`) so two overlapping ticks — e.g. a slow WeChat send
  still in flight when the next 60s interval fires — can never both read the
  same `pending` state before either one's `resolve()` lands. Both
  protections are independent and both matter: the reentrancy guard prevents
  the race at the in-process level, the store's atomic write prevents
  corruption if it ever happened anyway.
- `resume_topic` unchanged: Pulse never sends it proactively, still only
  injected on the next real inbound turn (spec §6, untouched by this).
- Lives inside the existing `cyberboss.service` process (`startPulse()`
  called once in `start()`, right after the bridge-loop-ready log line;
  `stopPulse()` in the shutdown handler alongside `clearMergeTimers()`) — no
  second daemon, no cron, no external scheduler.

Tested in `test/app-pulse.test.js` (fast `pulseIntervalMs` overrides, no real
I/O — stubs `runDueIntentionsCheck` directly): fires on interval, never
touches `sendSingleTurn` (proof that the tick path can't reach Claude even
indirectly), reentrancy guard blocks concurrent execution and correctly
resets after both a normal completion and a thrown error, `stopPulse()`
actually stops future ticks. `test/app-bubble-merge.test.js`'s shared setup
was extracted to `test/helpers/app-test-config.js` in the same pass (no
behavior change, just removed ~50 lines of duplicated fixture code once a
second test file needed the same `CyberbossApp` construction helper).

### Tasker observation — direction recorded, not implemented this session

Per vv's explicit instruction: don't guess the Android → Cyberboss transport
protocol, don't add an HTTP server/auth/public ingress this round. This
section is the recorded design boundary for a future session, not a
committed interface:

- Future Tasker-side observations Cyberboss should eventually be able to
  receive: battery level, charging status, location/place semantics, health
  data, app-usage duration.
- These are **external event inputs**, conceptually similar in shape to a
  WeChat inbound message but from a different channel — they may update
  `current-state.json` fields or trigger a `check_in` intention *with a
  concrete reason* (spec §6's existing check_in rule — "必须有具体对话理由" —
  already rules out a generic "phone at 12%" ping becoming a check-in on its
  own; whatever eventually consumes these observations needs to translate a
  raw reading into a real reason, not forward it verbatim).
- Same non-negotiable constraint as Pulse: observations must **not** trigger
  a Claude call per-observation. A battery-percentage update firing every few
  minutes calling Claude each time would be exactly the "high-frequency
  poller" both this session's Pulse spec and the original spec's "event-first"
  framing rule out.
- Transport, auth, wire format, and how an observation actually reaches this
  process are all explicitly undecided — to be designed in a dedicated
  session once the Android side's data format is worked out separately. No
  code, no new dependencies, no open port added this session.

### Final live acceptance — done, against vv's real WeChat account

`CYBERBOSS_ENABLE_SCHEDULED_INTENTIONS=true` flipped in `/etc/cyberboss.env`
per vv's explicit go-ahead in the same message that gave Pulse its scope.
Sequence actually run (all against the real deployed `cyberboss.service`, not
a simulation):

1. Created a real `reminder` intention directly via `intentionsStore.create()`
   (same function real turns use), `dueAt` ~150s out, on the live
   `/srv/cyberboss-lite/state/intentions.json`.
2. **Restart recovery while still pending**: `kill -9`'d the live main PID
   immediately after creation (before `dueAt`), confirmed `systemd`
   `Restart=always` brought up a fresh PID and the intention was still
   present, same `id`, still `pending`.
3. **Real `lock_busy` skip — twice, from genuine contention, not simulated**:
   once `dueAt` passed, Pulse's tick found it and tried
   `tryAcquireHostLock`, which correctly reported busy because this very cc
   session (Morrow) was actively holding `/run/agent-runtime/claude.lock` at
   the time — logged `{"sent":false,"reason":"lock_busy"}`, intention stayed
   `pending`, no preemption. This is strictly better evidence than a
   synthetic busy-lock test would have been.
4. **Real send, after vv's WeChat message refreshed the token**: see "context_token
   staleness" below — once vv sent a real WeChat message, the next Pulse tick
   sent the queued reminder successfully: `{"id":"int_39c4...","sent":true}`.
5. **Resolve without duplicate**: `intentions.json` confirmed `status:
   "resolved"` immediately after; grepping the log for
   `"id":"...","sent":true` for that id returns exactly `1` — structurally
   guaranteed going forward too, since `selectDueForExecution` only ever
   considers `status === "pending"` intentions.
6. Full suite: 135/135 (`npm test`), clean on both the dev tree and
   `/srv/cyberboss-lite/app` as `cyberboss`.

**Bonus real-traffic confirmation, not explicitly asked for but worth
recording**: vv's WeChat message arrived >6h after the previous real turn
(2026-08-06), which correctly triggered episode idle rollover (condition A)
*before* that turn's model call even ran (`prepareTurn`'s spec §8 ordering).
The old episode was archived (`episodes/archive/episode_22324946-....json`)
and a fresh one started — confirmed live, not just in the existing synthetic
`turn-coordinator.test.js` coverage.

### Two real issues found during this final pass, both fixed

Live traffic surfaced things no unit test had exercised — consistent with
every prior session's experience in this repo ("A real bug was caught by
testing, not inspection").

**1. `context_token` staleness blocks real proactive sends after ~44h of
no inbound traffic — a platform constraint, not a bug, but worth recording.**
Cyberboss's WeChat send (both normal replies and Pulse's proactive sends)
requires a `context_token` captured from the *last real inbound message*
(`src/adapters/channel/weixin/context-token-store.js`). vv's account hadn't
sent Cyberboss anything since the session-2 real-device verification
(2026-08-06); by the time Pulse tried to deliver the reminder, the gateway
rejected it with `sendMessage ret=-2 errcode= errmsg=prepare failed`.
Checked upstream Cyberboss's original (pre-Lite) proactive-send code
(`git show 373ab17:src/services/system-message-service.js`) — it used the
exact same "reuse last known persisted token" approach, with an explicit
comment: `"Let this user talk to the bot once first"`. This isn't new
breakage from session 3; it's the first time anything in this codebase has
actually attempted a truly proactive (non-reply) send, so it's the first
time this precondition mattered. **Unblocked itself** the moment vv sent a
real message — no code change needed, just documenting it because it's a
real operational constraint anyone running scheduled intentions needs to
know: a reminder can silently fail to deliver if the account has gone quiet
long enough for the gateway to expire the session, and it'll just keep
retrying every Pulse tick until either it succeeds or a human notices.

**2. `executeDueIntentions` had no `try/catch` around `sendFn` — a failing
send aborted the rest of that tick's due-intention loop.** Found because the
context_token failure above threw all the way up through
`runDueIntentionsCheck()`, only caught by Pulse's generic outer catch
(`console.error("pulse tick failed: ...")`) — which meant (a) any *other* due
intention in the same tick would never even be attempted that cycle, and (b)
the failure reason for the specific intention that failed was buried in a
generic log line instead of the structured `executed` array everything else
uses. Fixed in `src/core/intentions-store.js`: `sendFn` failures are now
caught per-intention, recorded as `{sent: false, reason: "send_failed",
error}`, the intention stays `pending` for retry next tick (same posture as
`lock_busy`), and the loop continues to any other due intentions. Regression
test added (`test/intentions-store.test.js`): two due intentions, first
`sendFn` throws, second must still succeed and resolve.

**3. (Related, smaller) `claude exited with code 1` with empty `stderr` was
undiagnosable.** A real chat turn (responding to vv's actual WeChat message)
failed this way once during the final pass — reproducing the identical call
immediately after succeeded cleanly (`"晚上好呀～今天过得怎么样？"`), so this
looks like a one-off CLI/network blip, not a systemic issue introduced this
session. But the failure *was* undiagnosable after the fact: `stdout` was
captured on the thrown `Error` object (for the existing not-logged-in retry
check) but never actually logged anywhere, and `stderr` was empty this time.
Fixed in `src/adapters/runtime/claudecode/index.js`:
`summarizeStdoutForDiagnostics()` adds a bounded summary to the error message
— if `stdout` parses as the CLI's JSON envelope, only non-content fields
(`type`/`subtype`/`is_error`/`stop_reason`/`num_turns`/`duration_ms`/
`total_cost_usd`) are surfaced, **never** `result`/`structured_output` (spec
§7: "日志不得记录正文" — those two fields are exactly where the model's real
reply text lives); if `stdout` isn't valid JSON, only a byte length is
reported, not the raw text. Three new tests assert the redaction directly
(a synthetic envelope with real-looking Chinese reply text in `result`/
`structured_output` must never appear in the summary).

### Session 3 close-out

- Full suite: **135/135** (`npm test`, dev tree and `/srv/cyberboss-lite/app`
  as `cyberboss`).
- `deploy/cyberboss.service` running live, `enable`d, `Restart=always`,
  `CYBERBOSS_ENABLE_SCHEDULED_INTENTIONS=true` in `/etc/cyberboss.env`.
- Deployed copy in sync with `lite` HEAD via the same `rsync --delete
  --exclude=node_modules --exclude=.git` + `node_modules` rsync pattern used
  since session 2 (no dependency changes this session).
- Working tree clean, all commits pushed to `origin/lite`.
- **Not in this session's scope, confirmed out-of-scope by vv**: Tasker
  ingestion itself (direction recorded above only), any change to Pulse
  beyond driving Future Intentions, any autonomous "reach out to chat"
  behavior.
- **Known operational note for whoever's on call next**: if scheduled
  reminders/check-ins stop delivering after a long quiet period, check for
  the `context_token` staleness pattern above before assuming the lock/Pulse
  mechanism broke — it's a WeChat-gateway session-window issue, and it
  self-heals the moment vv sends any real message.

## Session 4 (Cyberboss Proactive + keke-overflow Companion rework)

Cross-repo effort: this doc covers the `cyberboss-lite` half; the `keke-overflow`
half (Accessibility raw-context rework, `keke-sentinel.py`/`keke-jiwen.py`
retirement) is recorded in `keke-overflow/CLAUDE.md`'s 数据流 section and
`keke-overflow/cc-clawd-overhaul.md`'s superseded-阶段二 note. Task numbering
(#9-15) is from vv's in-chat plan, not a committed spec doc — same posture as
session 3's Pulse spec.

### Tasks #9-11 — observation adapters, narrow proactive contract, Stochastic Pulse skeleton

Committed as `c783c88` (see that commit's message and each new file's header
comment for the full rationale — not repeated here). Summary: three Supabase
observation adapters (`src/adapters/observation/*` — Tasker snapshot read,
companion segments read, `keke_state` expression write), `proactive-result-schema.js`
(the narrow `send_message`/`silent`/`need_context`/`defer` contract, structurally
unable to touch memory/loops/intentions), and the Stochastic Pulse skeleton
(`system-checkin-poller.js`, ported from upstream — random interval, enqueues
an observation bundle, never calls Claude itself). `app.js` was untouched by
that commit on purpose; wiring was deferred to this session.

### Task #13 — Event Opportunity poller

Fixed low-frequency poll (`config.eventOpportunityIntervalMs`, default 5min —
unlike Stochastic Pulse's random 3-60min range). New files:
`src/core/event-opportunity-detector.js` (pure delta comparison — new
companion-segment context / open-loop change / Tasker environment change /
long-silence edge-trigger) and `src/core/event-opportunity-state-store.js`
(persists what was last observed, across restarts), plus
`src/app/event-opportunity-poller.js` tying them to the shared
`system-message-queue-store` (source: `"event_opportunity"`, alongside
Stochastic Pulse's `"stochastic_pulse"`). Deliberately no Supabase Realtime
(vv's call, this session) — poll-and-diff only.

Two anti-spam mechanisms, doing different jobs: **dedupe** (the detector only
ever compares against the last *observed* snapshot, so a value that changes
once and then holds steady never re-fires — this is what stops "long silence"
from firing every single tick forever once the threshold is first crossed)
and **cooldown** (a blanket minimum gap between any two firings, a safety net
independent of which signal fired).

### Task #14 — app.js wiring: real proactive turns

The existing 60s Intentions Tick (`runPulseTick`, session 3) now does two
independent things under the same `pulseTickInFlight` reentrancy guard:
`runDueIntentionsCheck()` (unchanged) and the new `runProactiveDrainTick()`.
Deliberately one shared timer, not a fourth one — both already needed the
identical "never overlap with yourself, never preempt Morrow" posture, so a
separate timer would have bought nothing.

`runProactiveDrainTick()`: non-blocking `tryAcquireHostLock` (busy → skip,
message stays queued for next tick, exactly like scheduled intentions). Skips
before even touching the lock if the queue is empty or there's no
`allowedSenderId` yet (a proactive turn that can only end in `silent` isn't
worth a Claude call). On acquiring the lock, drains the queue and runs each
message through `src/core/proactive-turn-runner.js`'s `processProactiveMessage`
— a pure function (mirrors `intentions-store.js`'s `executeDueIntentions`
shape) that renders the prompt (`proactive-turn-builder.js`), calls the
runtime with `PROACTIVE_RESULT_JSON_SCHEMA` instead of the normal-turn schema
(`runtimeAdapter.sendSingleTurn` gained an optional `resultSchema` override
for this), validates via `evaluateProactiveResult`, and applies exactly one
side effect per action:

- `send_message`: WeChat send (`channelAdapter.sendText`, reusing the same
  persisted-`context_token` resolution real replies use), and only on a
  confirmed send: `currentStateStore.lastAgentMessageAt` updated (system-owned
  event timestamp, same bookkeeping category as a normal turn's — episode/
  memory/loops are untouched, the narrow contract structurally can't reach
  them) and a `keke_state` push (`expression: "alert"`, `bubbleText`: the
  message truncated to 40 chars — pet.html's bubble is a small popup, not
  the real message; the real text only ever goes out over WeChat).
- `silent` / `defer`: no side effect — see `proactive-result-schema.js`'s
  module comment for why these are different (`silent` = decided against it;
  `defer` = didn't decide).
- `need_context`: not a side effect itself — triggers task #12's round-2 relay
  (fetch a fresher Accessibility read, ask again), see below. Only the
  round-2 outcome (`send_message`/`silent`/`defer`) ever reaches this list.
- Runtime throwing, or the CLI returning something `evaluateProactiveResult`
  rejects: both fall back to `silent` rather than crashing the drain tick or
  forwarding a possibly-malformed message.

Observation credentials (`CYBERBOSS_TASKER_SUPABASE_*`/
`CYBERBOSS_COMPANION_SUPABASE_*`) are **still not set** in `/etc/cyberboss.env`
— task #9-11 added the adapters, not the real keys. `createSupabaseRestClient`
throws synchronously if `baseUrl`/`anonKey` are missing, so `app.js` wraps each
observation adapter construction in a stub that throws a clear
"not configured" error per-call instead of at boot — `observation-bundle.js`
already treats a rejected source as `{error}` rather than failing the whole
bundle, so this degrades to a local-only bundle (current state / open loops /
core memory, no Tasker/companion data) instead of refusing to start. Setting
the four env vars and restarting is enough to light up the remote half; no
code change needed.

135/135 → **224/224** (`npm test`), `npm run check` clean. New test files:
`test/event-opportunity-detector.test.js`, `test/event-opportunity-state-store.test.js`,
`test/event-opportunity-poller.test.js`, `test/proactive-turn-runner.test.js`,
`test/app-proactive-drain.test.js`; one addition to `test/claudecode-runtime.test.js`
(`resultSchema` override). Found and fixed one test-fixture gap while writing
`test/app-proactive-drain.test.js`: `test/helpers/app-test-config.js`'s
`hostLockDir` pointed at a tmp path that was never actually created (real
deployments rely on `/run/agent-runtime` already existing via systemd
tmpfiles — `flock` itself never `mkdir`s its lock file's parent) — no prior
test had exercised a real lock acquisition through `app.js`'s own methods
end-to-end, so this had gone uncaught since session 3.

**Deployed and live** (end of this session): `/home/keke/cyberboss-lite/app`
HEAD `b0efbdb` mirrored to `/srv/cyberboss-lite/app` via the same
`rsync -a --delete --exclude=node_modules --exclude=.git` + chown-to-`cyberboss`
pattern (no `package.json` changes this session, no `npm install` needed).
`npm run check` clean and `npm test` (230/231, 1 skipped — same real-path
try-lock test session 3 already documented as skipping without passwordless
sudo as `cyberboss`) both re-run clean on the deployed copy before restarting
anything. `systemctl restart cyberboss.service` — confirmed `active (running)`,
`NRestarts=0`, log shows a clean boot sequence ending in Stochastic Pulse's
own "next stochastic checkin in 45m" line (`system-checkin-poller.js`'s
`scheduleNext` log), no new errors in `state/cyberboss.log` since the restart.

**`/etc/cyberboss.env` still doesn't have the four observation env vars**
(`CYBERBOSS_TASKER_SUPABASE_URL`/`ANON_KEY`, `CYBERBOSS_COMPANION_SUPABASE_URL`/
`ANON_KEY`) — confirmed by reading the file directly this session. Practical
effect on the live process: Stochastic Pulse and Event Opportunity both run on
schedule and enqueue real bundles, Intentions Tick still drains them every
60s, but every bundle's `taskerSnapshot`/`companionSegments` fields come back
as `{error: "...not configured..."}` (the stub adapters from task #14) —
proactive turns only ever see local data (current state / open loops / core
memory) until those four vars are set. `need_context`'s round-2 fetch would
fail the same way, but still runs a real round 2 — the prompt just renders
`Refreshed Accessibility context: (unavailable — ...)` instead of real rows,
and the model decides with that acknowledgment (proactive-turn-builder.js's
error-tolerant rendering, same posture as the rest of the bundle). Setting
the four vars and restarting is enough to light up the remote half; no code
change needed. No live WeChat test of a real proactive send this session —
that's still open, same as before.

### Task #12 — need_context two-round relay: built

vv's call on the open question flagged earlier this session: `need_context`
(renamed from the earlier working name `need_vision` — the name itself was
implying more than what got built) means a fresher, fuller **on-demand
Accessibility text read**, not a screenshot. Real screenshot capture/upload +
Vision captioning stays out of scope — recorded as a future enhancement to
revisit once this text-only relay has real usage to learn from, not built
this session. `keke-overflow/cc-clawd-overhaul.md` 阶段三's "不存截图原图"
privacy stance stays fully intact; no on-device capture/upload code, no new
Supabase table or bucket, no new transport of any kind.

Mechanics: `companion-observation.js` gained `getLatestScreenContext()` — a
small (default limit 5), on-demand read of raw `companion_events` rows
(`event=screen_context`, ordered newest-first), deliberately separate from
`getRecentSegments()` (which stays on the hourly-aggregated
`companion_segments` for the standard bundle — pulling raw `companion_events`
on every wake-up would blow the token budget the module's original header
comment already warned about; this is a small, rare, explicitly-requested
exception). Same `package`/`activity`/truncated-`title`/sanitized-`url`
fields `KekeAccessibilityService` already writes (commit `b0f7483`), just
read unsmoothed and on demand instead of through the hourly cron.

`proactive-turn-builder.js`'s `buildProactiveTurnPrompt(bundle, { refreshedContext })`
renders two different prompts: round 1 (no second arg) offers `need_context`
as an option; round 2 (`refreshedContext` given — either the fetched rows or
an `{error}` marker) drops `need_context` from the menu entirely and shows
the refreshed rows instead. `proactive-turn-runner.js`'s
`processProactiveMessage` orchestrates both rounds and hard-caps at two: if
round 1 answers `need_context`, it fetches via the new adapter (a fetch
failure degrades to an `{error}` marker in the round-2 prompt, doesn't
abort), builds the round-2 prompt, and runs one more `callRuntime`. If round
2 *also* answers `need_context` (a contract violation — the prompt already
stopped offering it), that's treated the same as any other invalid result:
falls back to `silent` rather than a third round. `app.js` wires
`fetchRefreshedContext` to `this.companionObservationClient.getLatestScreenContext()`.

Two full rounds of `callRuntime`/`claude -p` happen only on the `need_context`
path — every other action (`send_message`/`silent`/`defer` on round 1) is
still exactly one Claude call, unchanged from task #14.

224/224 → **231/231** (`npm test`), `npm run check` clean. New/changed tests:
`test/observation-adapters.test.js` (`getLatestScreenContext`),
`test/proactive-turn-builder.test.js` (round-2 prompt shape, `need_context`
dropped from the menu), `test/proactive-turn-runner.test.js` (real two-round
flow, fetch-failure resilience, two-round cap), `test/app-proactive-drain.test.js`
(end-to-end wiring through `app.js`), `test/proactive-result-schema.test.js`
(renamed enum value).

### Session 4 close-out

- Full suite: **231/231** (`npm test`, dev tree), **230/231 + 1 skipped**
  (deployed copy as `cyberboss` — same real-path try-lock skip session 3
  documented). `npm run check` clean on both.
- `cyberboss-lite` commit `b0efbdb` on `lite`, pushed to `origin/lite`.
- `keke-overflow` commits `fbf304c` (unrelated pre-existing doc edit from
  before this session, committed on its own so it doesn't get attributed to
  this session's work) and `d8f4f8c` (this session's actual `CLAUDE.md`/
  `cc-clawd-overhaul.md` updates), both pushed to `origin/main`.
- Deployed to `/srv/cyberboss-lite/app`, `cyberboss.service` restarted,
  confirmed healthy (see "Deployed and live" above).
- **Not done this session**: the four observation env vars still aren't set
  in `/etc/cyberboss.env` (a deliberate no-touch — setting real Supabase
  credentials wasn't part of this session's scope), so Stochastic Pulse/
  Event Opportunity/`need_context` all run for real but only ever see local
  data on the live deployment right now. No live WeChat test of an actual
  proactive send. Real screenshot + Vision captioning stays a recorded
  future enhancement (task #12's resolution), not started.
