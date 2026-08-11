const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createSystemMessageQueueStore } = require("../src/core/system-message-queue-store");

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-queue-test-"));
  return { systemMessageQueueFile: path.join(dir, "system-message-queue.json") };
}

test("load returns an empty queue when no file exists yet", () => {
  const store = createSystemMessageQueueStore(tempConfig());
  assert.deepEqual(store.load(), { messages: [] });
});

test("new candidate round-trips without freezing an observation bundle", () => {
  const config = tempConfig();
  const store = createSystemMessageQueueStore(config);
  const next = store.enqueue(store.load(), {
    id: "m1", source: "event_opportunity", createdAt: "2026-08-09T00:00:00Z",
  });
  store.save(next);

  const reloaded = store.load();
  assert.equal(reloaded.messages.length, 1);
  assert.equal(reloaded.messages[0].id, "m1");
  assert.equal(reloaded.messages[0].forced, false);
  assert.equal("bundle" in reloaded.messages[0], false);
});

test("old frozen bundle schema loads for migration but remains explicitly legacy", () => {
  const config = tempConfig();
  const store = createSystemMessageQueueStore(config);
  store.save(store.enqueue(store.load(), {
    id: "old", source: "stochastic_pulse", createdAt: "2026-08-09T00:00:00Z", bundle: { a: 1 },
  }));
  const message = store.load().messages[0];
  assert.equal(message.source, "stochastic_pulse");
  assert.equal(message.legacyFrozenBundle, true);
  assert.deepEqual(message.bundle, { a: 1 });
});

test("enqueue rejects a message missing id/source/createdAt", () => {
  const store = createSystemMessageQueueStore(tempConfig());
  assert.throws(() => store.enqueue(store.load(), { source: "x", createdAt: "t" }));
  assert.throws(() => store.enqueue(store.load(), { id: "x", createdAt: "t" }));
  assert.throws(() => store.enqueue(store.load(), { id: "x", source: "y" }));
});

test("hasPending reflects queue contents", () => {
  const store = createSystemMessageQueueStore(tempConfig());
  let state = store.load();
  assert.equal(store.hasPending(state), false);
  state = store.enqueue(state, { id: "m1", source: "event_opportunity", createdAt: "t" });
  assert.equal(store.hasPending(state), true);
});

test("drainAll empties the queue and returns what was drained", () => {
  const store = createSystemMessageQueueStore(tempConfig());
  let state = store.load();
  state = store.enqueue(state, { id: "m1", source: "event_opportunity", createdAt: "t" });
  state = store.enqueue(state, { id: "m2", source: "event_opportunity", createdAt: "t2" });

  const { drained, state: nextState } = store.drainAll(state);
  assert.equal(drained.length, 2);
  assert.equal(store.hasPending(nextState), false);
});
