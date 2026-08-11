# Proactive Session 2

Cyberboss proactive outreach is now a local scheduler with a bounded model
decision layer.

## Runtime flow

1. The five-minute event poller rebuilds the observation bundle and compares
   it with the previous snapshot.
2. Weighted evidence is retained in `event-opportunity-state.json` for 30
   minutes. App changes must be stable for two polls; location changes are
   accepted immediately.
3. Evidence at score 3 creates one optional candidate. The candidate enters
   the existing `system-message-queue.json`; the bundle is rebuilt at drain
   time, so the queue never freezes an old observation.
4. The 60-second pulse checks Future Intentions, mandatory slots, and drains
   at most one candidate. It does not build observations or call a model when
   there is no work.

Before every actual proactive runtime call, Cyberboss acquires the shared host
lock, reserves the daily budget, rebuilds the observation, and requests one
fresh Clawd Accessibility context. Context failure is included as unavailable
context; it never causes a second model call.

## Limits and mandatory slots

- Six proactive Claude calls per local day.
- At least 90 minutes between proactive calls.
- Optional calls reserve the remaining three unsatisfied slots.
- Morning, afternoon, and evening slots persist their randomized `targetAt`; each
  target is sampled from `startAt` through `endAt - 90 minutes - 15 minutes`.
  The 15-minute margin keeps a mandatory call eligible inside its window even
  when an optional silent decision happens immediately before the target.
- A slot definition narrower than the 90-minute gap plus the 15-minute safety
  margin is a configuration error and fails fast; it never creates an
  out-of-window target.
- An optional successful message satisfies the slot it lands in.
- A forced slot gets one model call with a send-only result contract.
- A failed WeChat delivery stores the generated text for delivery-only retry;
  retrying never calls Claude again.
- Unsatisfied slots whose windows end are marked missed. A service that starts
  on a later date records the previous day's unfinished slots as
  `service_offline_window` and does not backfill them.

The persisted daily state also records call, delivery, context-refresh, lock,
budget, and slot counters, retaining the most recent 30 days.

## Migration notes

The old stochastic scheduler and its random enqueue path are retired. The
runtime no longer reads `checkin-config.json`; an existing file is left in
place as user data. Existing queue records containing a frozen `bundle` remain
loadable for migration, but the drain ignores that bundle and rebuilds fresh
state. New queue records contain only candidate metadata.

The normal WeChat chat path, memory, episodes, Future Intentions, and the
shared host runtime lock are unchanged.
