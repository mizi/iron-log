// Sync for Iron Log: a merge function, a provider contract, one provider per
// backend, and an engine that runs pull → merge → push one request at a time.
(function (root) {
  "use strict";

  // ---------- merge ----------
  // Data shape: { prefs, prefsUpdatedAt, sessions: { "YYYY-MM-DD": { date, sets: [{id, ...}] } }, deleted: { setId: epochMs } }
  // Sets merge as a union by id minus tombstones; prefs are last-writer-wins.
  function mergeData(a, b) {
    a = a || {}; b = b || {};
    const deleted = Object.assign({}, a.deleted, b.deleted);
    for (const id of Object.keys(b.deleted || {})) deleted[id] = Math.max((a.deleted || {})[id] || 0, b.deleted[id]);

    const sessions = {};
    for (const src of [a.sessions || {}, b.sessions || {}]) {
      for (const [date, s] of Object.entries(src)) {
        if (!s || !Array.isArray(s.sets)) continue;
        const byId = sessions[date] ? new Map(sessions[date].sets.map(x => [x.id, x])) : new Map();
        for (const set of s.sets) if (set && set.id && !deleted[set.id] && !byId.has(set.id)) byId.set(set.id, set);
        sessions[date] = { date, sets: [...byId.values()] };
      }
    }
    for (const date of Object.keys(sessions)) {
      sessions[date].sets.sort((x, y) => String(x.t).localeCompare(String(y.t)) || String(x.id).localeCompare(String(y.id)));
      if (!sessions[date].sets.length) delete sessions[date];
    }

    const aAt = a.prefsUpdatedAt || 0, bAt = b.prefsUpdatedAt || 0;
    const prefs = bAt > aAt ? b.prefs : (a.prefs || b.prefs);
    return { app: "iron-log", version: 1, prefs, prefsUpdatedAt: Math.max(aAt, bAt), sessions, deleted };
  }

  // ---------- provider contract ----------
  // Every provider implements:
  //   pull()               → Promise<{ data: object|null, version: string|null }>
  //                          data is null when nothing has been synced yet.
  //   push(data, version)  → Promise<string>  the new version.
  //                          `version` is what the last pull returned (null to create).
  // and fails only with a SyncError whose `kind` is one of:
  //   "auth"     credentials missing, wrong or lacking permission
  //   "notfound" the configured location doesn't exist
  //   "conflict" someone else wrote since `version`; pull and merge again
  //   "network"  offline or the service didn't answer
  //   "other"    anything else
  class SyncError extends Error {
    constructor(kind, message) { super(message); this.kind = kind; }
  }
  class SyncProvider {
    pull() { return Promise.reject(new SyncError("other", "pull is not implemented")); }
    push() { return Promise.reject(new SyncError("other", "push is not implemented")); }
  }

  // ---------- GitHub: one JSON file in a private repository ----------
  const utf8ToB64 = s => { const bytes = new TextEncoder().encode(s); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };
  const b64ToUtf8 = b => { const bin = atob(b.replace(/\s/g, "")); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); };

  class GitHubRepoProvider extends SyncProvider {
    constructor({ repo, token, path = "iron-log.json", fetchImpl }) {
      super();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new SyncError("notfound", "Repository must look like owner/name.");
      if (!token) throw new SyncError("auth", "An access token is required.");
      this.url = `https://api.github.com/repos/${repo}/contents/${path}`;
      this.token = token;
      this.fetch = fetchImpl || ((...args) => root.fetch(...args));
    }
    async request(method, body) {
      let res;
      try {
        res = await this.fetch(this.url + (method === "GET" ? `?t=${Date.now()}` : ""), {
          method,
          headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store"
        });
      } catch (_) { throw new SyncError("network", "Couldn't reach GitHub."); }
      if (res.ok) return res.json();
      if (res.status === 401 || res.status === 403) throw new SyncError("auth", "GitHub refused the token. Check it hasn't expired and can write Contents on this repository.");
      if (res.status === 404) return null;
      if (res.status === 409 || res.status === 422) throw new SyncError("conflict", "The file changed on GitHub.");
      throw new SyncError(res.status >= 500 ? "network" : "other", `GitHub answered ${res.status}.`);
    }
    async pull() {
      const file = await this.request("GET");
      if (!file) {
        // Distinguish "repo exists, file not yet created" from "repo missing / no access".
        const repoUrl = this.url.replace(/\/contents\/.*$/, "");
        let ok = false;
        try { ok = (await this.fetch(repoUrl, { headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json" }, cache: "no-store" })).ok; } catch (_) { throw new SyncError("network", "Couldn't reach GitHub."); }
        if (!ok) throw new SyncError("notfound", "That repository doesn't exist, or the token can't see it.");
        return { data: null, version: null };
      }
      let data;
      try { data = JSON.parse(b64ToUtf8(file.content || "")); } catch (_) { throw new SyncError("other", "The synced file on GitHub isn't valid Iron Log data."); }
      return { data, version: file.sha };
    }
    async push(data, version) {
      const body = { message: `Sync ${new Date().toISOString()}`, content: utf8ToB64(JSON.stringify(data, null, 1)) };
      if (version) body.sha = version;
      const res = await this.request("PUT", body);
      if (!res || !res.content) throw new SyncError("notfound", "That repository doesn't exist, or the token can't see it.");
      return res.content.sha;
    }
  }

  // Composition root for backends: add a provider by registering it here.
  const providers = {
    github: cfg => new GitHubRepoProvider(cfg)
  };
  function createProvider(config) {
    const make = config && providers[config.provider];
    if (!make) throw new SyncError("other", `Unknown sync provider: ${config && config.provider}`);
    return make(config);
  }

  // ---------- engine ----------
  // getLocal() returns the current local data; applyMerged(data) replaces it.
  class SyncEngine {
    constructor(provider, { getLocal, applyMerged }) {
      this.provider = provider; this.getLocal = getLocal; this.applyMerged = applyMerged;
      this.running = null; this.again = false;
    }
    sync() {
      if (this.running) { this.again = true; return this.running; }
      this.running = (async () => {
        try {
          do { this.again = false; await this.once(); } while (this.again);
        } finally { this.running = null; }
      })();
      return this.running;
    }
    async once() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: remote, version } = await this.provider.pull();
        const merged = mergeData(remote, this.getLocal());
        this.applyMerged(merged);
        if (remote && JSON.stringify(mergeData(remote, {})) === JSON.stringify(merged)) return; // nothing new to send
        try { await this.provider.push(merged, version); return; }
        catch (e) { if (!(e instanceof SyncError) || e.kind !== "conflict") throw e; }
      }
      throw new SyncError("conflict", "Another device kept writing at the same time. Try again in a moment.");
    }
  }

  const api = { mergeData, SyncError, SyncProvider, GitHubRepoProvider, createProvider, SyncEngine, providers };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IronSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
