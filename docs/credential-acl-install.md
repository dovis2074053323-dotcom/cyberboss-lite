# Credential ACL preflight — install / reproduce

Why this exists, in one line: keke's own `claude` CLI rewrites (not edits)
`~/.claude/.credentials.json` on every OAuth refresh — a fresh inode — which
silently drops any ACL grant that let `cyberboss` read the previous one.
Full root-cause writeup lives in `docs/cyberboss-lite-status.md` ("Credential
ACL: root cause and fix"). This doc is only the install/reproduce steps.

Both files below are also committed at `deploy/cyberboss-ensure-claude-credential-acl`
and `deploy/cyberboss-credential-acl.sudoers` — install by copying them to the
paths below, not by hand-retyping.

## 1. Install the fixed script

```
sudo install -o root -g root -m 0755 \
  deploy/cyberboss-ensure-claude-credential-acl \
  /usr/local/sbin/cyberboss-ensure-claude-credential-acl
```

Required invariants, all enforced by `install -o root -g root -m 0755`:

- Owned by `root:root`. Neither `keke` nor `cyberboss` may own or write it —
  `0755` means only root can modify it, everyone else can only read/execute.
- Lives under `/usr/local/sbin`, not inside either user's home directory.
- The script itself takes zero arguments, targets exactly one hardcoded path
  (`/home/keke/.claude/.credentials.json`), refuses symlinks, confirms the
  target is a regular file before touching it, and never reads or prints the
  file's contents — the only privileged action it takes is one `setfacl`
  call.

## 2. Install the sudoers rule

```
sudo install -o root -g root -m 0440 \
  deploy/cyberboss-credential-acl.sudoers \
  /etc/sudoers.d/cyberboss-claude-acl
```

**Validate before and after installing** — a broken file under `/etc/sudoers.d/`
can lock out `sudo` entirely:

```
sudo visudo -cf deploy/cyberboss-credential-acl.sudoers
sudo visudo -cf /etc/sudoers.d/cyberboss-claude-acl
```

`0440 root:root` is required: sudoers fragments must not be group/other
writable, and `visudo` itself will refuse to honor a file with looser
permissions.

The rule grants exactly one thing: `cyberboss` may run
`/usr/local/sbin/cyberboss-ensure-claude-credential-acl` as `keke`,
password-less, with no arguments substituted in (sudoers' own arg-matching
only constrains *which* command may run, not the argument count — the
script's own `$# -ne 0` check is what actually rejects extra arguments; both
layers matter, neither is redundant).

## 3. Verify

```
# cyberboss can now reach the one credential file via the preflight script:
sudo -u cyberboss sudo -u keke /usr/local/sbin/cyberboss-ensure-claude-credential-acl
sudo -u cyberboss cat /home/keke/.claude/.credentials.json > /dev/null && echo OK

# ...but nothing else under keke's home:
sudo -u cyberboss ls /home/keke/.claude          # must be: Permission denied
sudo -u cyberboss cat /home/keke/.claude/settings.json   # must be: Permission denied

# no directory-level default ACL exists anywhere on the path (see status doc
# for why a default ACL was rejected as too broad):
getfacl /home/keke/.claude
getfacl /home/keke
```

`getfacl` on both directories should show only the pre-existing `--x`
(traverse-only) entries for `cyberboss`, no `default:` lines.

## Not part of this install

No systemd unit, no ACL heartbeat/poller. The runtime adapter
(`src/adapters/runtime/claudecode/index.js`) runs this preflight
synchronously before every single `claude` call it makes — normal replies,
and (once wired) Pulse and scheduled intentions all go through the same
`sendSingleTurn`, so they're all covered without a separate timer. Session 3
adds exactly one more preflight call, at systemd start, before the bridge
loop begins accepting messages — still no polling.
