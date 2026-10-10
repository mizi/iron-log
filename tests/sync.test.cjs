const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeData, SyncError, SyncProvider, GitHubRepoProvider, SyncEngine, createProvider } = require("../sync.js");

const set = (id, t = "10:00", ex = "Squat") => ({ id, ex, w: 100, r: 5, t });
const data = (sessions, extra = {}) => ({ prefs: { exercises: ["Squat"], unit: "kg" }, prefsUpdatedAt: 0, sessions, deleted: {}, ...extra });

test("merge keeps sets from both devices", () => {
  const a = data({ "2026-10-09": { date: "2026-10-09", sets: [set("a1", "09:00")] } });
  const b = data({ "2026-10-09": { date: "2026-10-09", sets: [set("b1", "09:30")] }, "2026-10-08": { date: "2026-10-08", sets: [set("b0")] } });
  const m = mergeData(a, b);
  assert.deepEqual(m.sessions["2026-10-09"].sets.map(s => s.id), ["a1", "b1"]);
  assert.equal(m.sessions["2026-10-08"].sets.length, 1);
});

test("a deletion on one device removes the set everywhere", () => {
  const phone = data({}, { deleted: { x: 5 } });
  const laptop = data({ "2026-10-09": { date: "2026-10-09", sets: [set("x"), set("y")] } });
  const m = mergeData(laptop, phone);
  assert.deepEqual(m.sessions["2026-10-09"].sets.map(s => s.id), ["y"]);
  assert.equal(m.deleted.x, 5);
});

test("a day with every set deleted disappears", () => {
  const m = mergeData(data({ "2026-10-09": { date: "2026-10-09", sets: [set("x")] } }), data({}, { deleted: { x: 1 } }));
  assert.equal(m.sessions["2026-10-09"], undefined);
});

test("newer settings win", () => {
  const old = data({}, { prefs: { exercises: ["Squat"], unit: "kg" }, prefsUpdatedAt: 10 });
  const fresh = data({}, { prefs: { exercises: ["Squat", "Dip"], unit: "lb" }, prefsUpdatedAt: 20 });
  assert.equal(mergeData(old, fresh).prefs.unit, "lb");
  assert.equal(mergeData(fresh, old).prefs.unit, "lb");
});

test("merging with nothing remote returns local data", () => {
  const local = data({ "2026-10-09": { date: "2026-10-09", sets: [set("a")] } });
  assert.equal(mergeData(null, local).sessions["2026-10-09"].sets[0].id, "a");
});

class FakeProvider extends SyncProvider {
  constructor() { super(); this.data = null; this.version = 0; this.conflictsLeft = 0; this.pushes = 0; }
  async pull() { return { data: this.data && JSON.parse(JSON.stringify(this.data)), version: this.data ? String(this.version) : null }; }
  async push(d, v) {
    if (this.conflictsLeft > 0) { this.conflictsLeft--; this.version++; throw new SyncError("conflict", "changed"); }
    if ((this.data ? String(this.version) : null) !== v) throw new SyncError("conflict", "stale");
    this.pushes++; this.data = JSON.parse(JSON.stringify(d)); this.version++; return String(this.version);
  }
}

test("engine uploads local data and merges into the device", async () => {
  const remote = new FakeProvider();
  remote.data = data({ "2026-10-08": { date: "2026-10-08", sets: [set("r")] } });
  let local = data({ "2026-10-09": { date: "2026-10-09", sets: [set("l")] } });
  await new SyncEngine(remote, { getLocal: () => local, applyMerged: m => { local = m; } }).sync();
  assert.deepEqual(Object.keys(local.sessions).sort(), ["2026-10-08", "2026-10-09"]);
  assert.deepEqual(Object.keys(remote.data.sessions).sort(), ["2026-10-08", "2026-10-09"]);
});

test("engine skips the upload when nothing changed", async () => {
  const remote = new FakeProvider();
  remote.data = mergeData(data({ "2026-10-08": { date: "2026-10-08", sets: [set("r")] } }), {});
  let local = JSON.parse(JSON.stringify(remote.data));
  await new SyncEngine(remote, { getLocal: () => local, applyMerged: m => { local = m; } }).sync();
  assert.equal(remote.pushes, 0);
});

test("engine retries after a conflict", async () => {
  const remote = new FakeProvider();
  remote.conflictsLeft = 1;
  let local = data({ "2026-10-09": { date: "2026-10-09", sets: [set("l")] } });
  await new SyncEngine(remote, { getLocal: () => local, applyMerged: m => { local = m; } }).sync();
  assert.equal(remote.pushes, 1);
});

test("engine passes other errors through", async () => {
  const p = new SyncProvider();
  await assert.rejects(new SyncEngine(p, { getLocal: () => ({}), applyMerged: () => {} }).sync(), e => e instanceof SyncError);
});

// ---------- GitHub provider against a fake API ----------
function fakeGitHub({ repoExists = true, status } = {}) {
  const files = {};
  let sha = 0;
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const json = (code, body) => ({ ok: code < 300, status: code, json: async () => body });
    if (status) return json(status, {});
    const path = url.split("?")[0];
    if (!path.includes("/contents/")) return json(repoExists ? 200 : 404, {});
    if (!repoExists) return json(404, {});
    if ((opts.method || "GET") === "GET") return files[path] ? json(200, files[path]) : json(404, {});
    const body = JSON.parse(opts.body);
    if (files[path] && body.sha !== files[path].sha) return json(409, {});
    files[path] = { sha: String(++sha), content: body.content };
    return json(files[path] && sha === 1 ? 201 : 200, { content: { sha: String(sha) } });
  };
  return { fetchImpl, calls };
}

test("github provider round-trips non-ASCII data and reports versions", async () => {
  const gh = fakeGitHub();
  const p = new GitHubRepoProvider({ repo: "me/data", token: "t", fetchImpl: gh.fetchImpl });
  assert.deepEqual(await p.pull(), { data: null, version: null });
  const v1 = await p.push({ prefs: { exercises: ["Жим лёжа 🏋️"] } }, null);
  const got = await p.pull();
  assert.equal(got.version, v1);
  assert.equal(got.data.prefs.exercises[0], "Жим лёжа 🏋️");
  assert.equal(gh.calls[0].opts.headers.Authorization, "Bearer t");
});

test("github provider maps a stale write to a conflict", async () => {
  const gh = fakeGitHub();
  const p = new GitHubRepoProvider({ repo: "me/data", token: "t", fetchImpl: gh.fetchImpl });
  await p.push({ a: 1 }, null);
  await assert.rejects(p.push({ a: 2 }, "stale"), e => e.kind === "conflict");
});

test("github provider reports auth and missing-repo errors", async () => {
  const bad = new GitHubRepoProvider({ repo: "me/data", token: "t", fetchImpl: fakeGitHub({ status: 401 }).fetchImpl });
  await assert.rejects(bad.pull(), e => e.kind === "auth");
  const missing = new GitHubRepoProvider({ repo: "me/data", token: "t", fetchImpl: fakeGitHub({ repoExists: false }).fetchImpl });
  await assert.rejects(missing.pull(), e => e.kind === "notfound");
  const offline = new GitHubRepoProvider({ repo: "me/data", token: "t", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(offline.pull(), e => e.kind === "network");
});

test("createProvider picks the backend from config", () => {
  assert.ok(createProvider({ provider: "github", repo: "me/data", token: "t" }) instanceof GitHubRepoProvider);
  assert.throws(() => createProvider({ provider: "nope" }), e => e instanceof SyncError);
  assert.throws(() => createProvider({ provider: "github", repo: "bad", token: "t" }), e => e.kind === "notfound");
});
