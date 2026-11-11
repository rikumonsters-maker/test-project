import test from "node:test";
import assert from "node:assert/strict";
import { createPersonalSync } from "./personal-sync.mjs";

function memoryStorage() {
  const values = new Map();
  return {
    values,
    failWrites:false,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { if (this.failWrites) throw new Error("quota"); values.set(key, String(value)); },
  };
}

async function activeSync(storage, state = { events:{} }) {
  const requests = [];
  const sync = createPersonalSync({
    storage, key:"synthetic-account", state,
    makeId:(() => { let id=0; return () => `synthetic-${++id}`; })(),
    requestJson:async (path, options = {}) => {
      requests.push({ path, payload:options.payload });
      if (path === "/api/personal/events/status") return { active:true };
      if (path === "/api/personal/events/sync?cursor=0") return { events:[], cursor:0, hasMore:false };
      if (path === "/api/personal/events/create") return { event:{ ...options.payload.event, id:options.payload.id, version:1, deleted:false } };
      throw new Error(`Unexpected request ${path}`);
    },
  });
  await sync.initialize();
  return { sync, state, requests };
}

test("queueMany writes a confirmed import atomically to the existing V2 sync queue", async () => {
  const storage = memoryStorage();
  const { sync, state, requests } = await activeSync(storage);
  const count = sync.queueMany([
    { id:"import-1", date:"2026-11-12", title:"研究室ミーティング", start:"14:00", end:"15:30", allDay:false, note:"", extra:{} },
    { id:"import-2", date:"2026-11-12", title:"歯医者", start:"18:00", end:"19:00", allDay:false, note:"", extra:{} },
  ]);
  assert.equal(count, 2);
  assert.deepEqual(requests.map(({ path }) => path), ["/api/personal/events/status", "/api/personal/events/sync?cursor=0"]);
  assert.equal(state.events["2026-11-12"].length, 2);
  const saved = JSON.parse(storage.getItem("synthetic-account-personal-sync-v2"));
  assert.deepEqual(saved.queue.map((operation) => operation.action), ["create", "create"]);
  assert.equal(saved.queue[0].event.title, "研究室ミーティング");
  assert.equal(JSON.stringify(saved).includes("sourceText"), false);
  assert.equal(JSON.stringify(saved).includes("image"), false);
  await sync.sync();
  const createRequests = requests.filter(({ path }) => path === "/api/personal/events/create");
  assert.equal(createRequests.length, 2);
  assert.equal(createRequests[0].payload.syncProtocol, 2);
  assert.equal(createRequests[0].payload.event.title, "研究室ミーティング");
  assert.equal(createRequests[0].payload.event.date, "2026-11-12");
  assert.equal(JSON.stringify(createRequests).includes("sourceText"), false);
  assert.equal(JSON.stringify(createRequests).includes("image"), false);
});

test("queueMany refuses local-only mode and restores the previous queue after storage quota failure", async () => {
  const inactiveStorage = memoryStorage();
  const inactiveState = { events:{} };
  const inactive = createPersonalSync({
    storage:inactiveStorage, key:"inactive", state:inactiveState,
    requestJson:async (path) => path === "/api/personal/events/status" ? { active:false } : { events:[], cursor:0, hasMore:false },
  });
  await inactive.initialize();
  assert.throws(() => inactive.queueMany([{ id:"one", date:"2026-11-12", title:"予定", start:"10:00", end:"11:00" }]), /同期状態/);
  assert.deepEqual(inactiveState.events, {});

  const storage = memoryStorage();
  const { sync, state } = await activeSync(storage);
  const before = storage.getItem("synthetic-account-personal-sync-v2");
  storage.failWrites = true;
  assert.throws(() => sync.queueMany([{ id:"import-1", date:"2026-11-12", title:"予定", start:"10:00", end:"11:00" }]), /容量|quota/);
  assert.equal(storage.getItem("synthetic-account-personal-sync-v2"), before);
  assert.deepEqual(state.events, {});
});
