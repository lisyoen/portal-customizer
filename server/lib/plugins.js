// Plugin host: optional server-side modules installed next to the data (DATA/plugins/<id>/) or given by
// PC_PLUGIN_DIRS (development). A plugin is a folder with plugin.json and, optionally, a server module
// (register(api)) and a public/ folder served at /p/<id>/. Plugins add API routes (/api/p/<id>/...), admin pages,
// panel types and site connectors that the extension runs in the portal's own tab (see docs/plugins.md), and
// can provide services to each other (api.provide / api.use). A plugin that fails to load is shown with its
// error and does not stop the server.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const KINDS = new Set(["identity", "notify", "profile", "share", "source"]);

// every entry of a zip archive (stored or deflated); names are checked so nothing is written outside the target
function zipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("zip 파일이 아닙니다");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip 파일이 아닙니다");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 구조가 올바르지 않습니다");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("zip 구조가 올바르지 않습니다");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.slice(start, start + csize);
    let data;
    if (method === 0) data = raw; else if (method === 8) data = zlib.inflateRawSync(raw); else throw new Error("지원하지 않는 압축 방식입니다");
    out.push({ name, data });
  }
  return out;
}

class PluginHost {
  constructor(opts) {
    this.o = opts; // { dataDir, coreVersion, store: () => Store, route, need, fail, json, send, readBody, baseUrl, log }
    this.dir = path.join(opts.dataDir, "plugins");
    this.dataRoot = path.join(opts.dataDir, "plugin-data");
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.dataRoot, { recursive: true });
    this.plugins = new Map(); // id -> state
    this.services = new Map(); // kind -> [{ plugin, name, impl }]
  }
  settings() { const s = this.o.store().data.settings; if (!s.plugins || typeof s.plugins !== "object") s.plugins = {}; return s.plugins; }
  enabled(id) { const s = this.settings()[id]; return !(s && s.enabled === false); }
  folders() {
    const list = [];
    for (const d of String(process.env.PC_PLUGIN_DIRS || "").split(path.delimiter).filter(Boolean)) list.push({ dir: path.resolve(d), dev: true });
    for (const f of fs.readdirSync(this.dir)) if (!f.startsWith(".") && fs.statSync(path.join(this.dir, f)).isDirectory()) list.push({ dir: path.join(this.dir, f), dev: false });
    return list;
  }
  loadAll() {
    for (const { dir, dev } of this.folders()) this.load(dir, dev);
  }
  readManifest(dir) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
    if (!m || !ID_RE.test(String(m.id || ""))) throw new Error("plugin.json 의 id 가 올바르지 않습니다(영소문자·숫자·하이픈 2~40자)");
    return { id: m.id, name: String(m.name || m.id).slice(0, 80), version: String(m.version || "0.0.0").slice(0, 20), description: String(m.description || "").slice(0, 300),
      main: m.main ? String(m.main) : "", minCore: m.minCore ? String(m.minCore) : "" };
  }
  unload(id) {
    const st = this.plugins.get(id);
    if (!st) return;
    try { if (st.dispose) st.dispose(); } catch (e) { this.o.log(`plugin ${id} dispose: ${e.message}`); }
    for (const [k, list] of this.services) this.services.set(k, list.filter((x) => x.plugin !== id));
    if (st.mainFile) for (const k of Object.keys(require.cache)) if (k.startsWith(st.dir + path.sep)) delete require.cache[k];
    this.plugins.delete(id);
  }
  load(dir, dev) {
    let man;
    try { man = this.readManifest(dir); } catch (e) { this.o.log(`plugin ${dir}: ${e.message}`); return null; }
    if (this.plugins.has(man.id)) this.unload(man.id);
    const st = { ...man, dir, dev: !!dev, routes: [], panels: [], panelSource: null, connectors: [], adminPages: [], error: "", loadedAt: new Date().toISOString(), dispose: null, mainFile: "" };
    this.plugins.set(man.id, st);
    if (man.minCore && cmpVer(this.o.coreVersion, man.minCore) < 0) { st.error = `관리 서버 v${man.minCore} 이상이 필요합니다`; return st; }
    if (!man.main) return st;
    try {
      const file = path.resolve(dir, man.main);
      if (!file.startsWith(dir + path.sep)) throw new Error("main 경로가 올바르지 않습니다");
      st.mainFile = file;
      const mod = require(file);
      const reg = typeof mod === "function" ? mod : mod && mod.register;
      if (typeof reg !== "function") throw new Error("register(api) 함수가 없습니다");
      const r = reg(this.api(st));
      if (r && typeof r.then === "function") r.catch((e) => { st.error = e.message; this.o.log(`plugin ${man.id}: ${e.stack || e}`); });
      if (r && typeof r.dispose === "function") st.dispose = r.dispose;
    } catch (e) { st.error = e.message; this.o.log(`plugin ${man.id}: ${e.stack || e}`); }
    return st;
  }
  api(st) {
    const host = this, o = this.o, id = st.id;
    const dataDir = path.join(this.dataRoot, id);
    fs.mkdirSync(dataDir, { recursive: true });
    return {
      id, version: st.version, dir: st.dir, dataDir, coreVersion: o.coreVersion,
      // handler(req, res, params, query, ctx) — return a value to send it as JSON
      route(method, pattern, handler) {
        if (!/^\//.test(pattern)) throw new Error("route 경로는 / 로 시작해야 합니다");
        const keys = [];
        const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_m, k) => { keys.push(k); return "([^/]+)"; }) + "$");
        st.routes.push({ method: String(method).toUpperCase(), re, keys, handler });
      },
      // panel types the extension offers in its "add panel" menu; path is under /p/<id>/
      panel(def) { st.panels.push(cleanPanel(def)); },
      // panels that depend on the plugin's data (e.g. one per board): fn() returns panel definitions, asked each
      // time portal-customizer.json is served
      panelSource(fn) { if (typeof fn === "function") st.panelSource = fn; },
      // declarative request run by the extension inside the portal tab (docs/plugins.md "connectors")
      connector(def) { st.connectors.push(cleanConnector(def)); },
      adminPage(def) { st.adminPages.push({ id: String(def.id || "main").replace(/[^\w-]/g, "").slice(0, 40), title: String(def.title || st.name).slice(0, 40), path: cleanPath(def.path || "/admin.html") }); },
      provide(kind, name, impl) {
        if (!KINDS.has(kind)) throw new Error("알 수 없는 서비스 종류: " + kind);
        const list = (host.services.get(kind) || []).filter((x) => !(x.plugin === id && x.name === name));
        list.push({ plugin: id, name: String(name), impl });
        host.services.set(kind, list);
      },
      use(kind) { return (host.services.get(kind) || []).filter((x) => host.enabled(x.plugin)).map((x) => Object.assign({ plugin: x.plugin, name: x.name }, x.impl)); },
      settings: {
        get() { const s = host.settings()[id]; return Object.assign({}, s && s.config); },
        set(v) { const all = host.settings(); all[id] = Object.assign({}, all[id], { config: v }); o.store().save(); },
      },
      audit(by, action, target, detail) { o.store().audit(by, `[${id}] ${action}`, target, detail); o.store().saveSoon(); },
      log(msg) { o.log(`plugin ${id}: ${msg}`); },
      need: o.need, fail: o.fail, json: o.json, send: o.send, readBody: o.readBody, baseUrl: o.baseUrl,
    };
  }
  // dispatch /api/p/<id>/<rest>; returns true when handled
  async dispatch(req, res, p, query) {
    const m = /^\/api\/p\/([a-z0-9-]+)(\/.*)?$/.exec(p);
    if (!m) return false;
    const st = this.plugins.get(m[1]);
    if (!st || !this.enabled(st.id) || st.error) throw this.o.fail(404, "플러그인이 없거나 꺼져 있습니다");
    const rest = m[2] || "/";
    for (const r of st.routes) {
      if (r.method !== req.method && !(req.method === "HEAD" && r.method === "GET")) continue;
      const mm = r.re.exec(rest);
      if (!mm) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(mm[i + 1])]));
      const out = await r.handler(req, res, params, query, { plugin: st.id });
      if (out !== undefined && !res.headersSent) this.o.send(res, 200, out);
      return true;
    }
    throw this.o.fail(404, "없는 API 입니다");
  }
  // /p/<id>/<file> from the plugin's public folder; null = not a plugin path, "" = not found
  staticFile(p) {
    const m = /^\/p\/([a-z0-9-]+)(\/.*)?$/.exec(p);
    if (!m) return null;
    const st = this.plugins.get(m[1]);
    if (!st || !this.enabled(st.id)) return "";
    const root = path.join(st.dir, "public");
    const f = path.join(root, path.normalize(m[2] && m[2] !== "/" ? m[2] : "/index.html"));
    return f.startsWith(root + path.sep) ? f : "";
  }
  allPanels(st) {
    let extra = [];
    if (st.panelSource) { try { extra = (st.panelSource() || []).slice(0, 200).map(cleanPanel); } catch (e) { this.o.log(`plugin ${st.id} panels: ${e.message}`); } }
    const names = new Set(st.panels.map((x) => x.name));
    return st.panels.concat(extra.filter((x) => !names.has(x.name)));
  }
  // what the extension gets in portal-customizer.json
  published(base) {
    const out = [];
    for (const st of this.plugins.values()) {
      if (!this.enabled(st.id) || st.error) continue;
      const panels = this.allPanels(st);
      if (!panels.length && !st.connectors.length) continue;
      out.push({ id: st.id, name: st.name, version: st.version, base: `${base}/p/${st.id}/`,
        panels: panels.map((x) => Object.assign({}, x, { url: `${base}/p/${st.id}${x.path}` })), connectors: st.connectors });
    }
    return out;
  }
  list() {
    return [...this.plugins.values()].map((st) => ({ id: st.id, name: st.name, version: st.version, description: st.description, dev: st.dev, enabled: this.enabled(st.id),
      error: st.error, loadedAt: st.loadedAt, routes: st.routes.length, panels: this.allPanels(st).map((x) => x.title), connectors: st.connectors.map((x) => x.id),
      adminPages: st.adminPages.map((x) => Object.assign({}, x, { url: `/p/${st.id}${x.path}` })), services: [...this.services.entries()].flatMap(([k, l]) => l.filter((x) => x.plugin === st.id).map((x) => `${k}:${x.name}`)) }));
  }
  // install or replace from a zip: plugin.json at the top or inside one top folder
  install(buf) {
    const entries = zipEntries(buf);
    const manEntry = entries.find((e) => /^([^/]+\/)?plugin\.json$/.test(e.name));
    if (!manEntry) throw new Error("plugin.json 이 없는 패키지입니다");
    const prefix = manEntry.name.slice(0, -"plugin.json".length);
    const tmp = fs.mkdtempSync(path.join(this.dir, ".tmp-"));
    try {
      for (const e of entries) {
        if (!e.name.startsWith(prefix)) continue;
        const rel = e.name.slice(prefix.length);
        const target = path.join(tmp, path.normalize(rel));
        if (!target.startsWith(tmp + path.sep)) throw new Error("패키지 안 경로가 올바르지 않습니다: " + rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, e.data);
      }
      const man = this.readManifest(tmp);
      const dest = path.join(this.dir, man.id);
      const dev = [...this.plugins.values()].find((x) => x.id === man.id && x.dev);
      if (dev) throw new Error("개발용 폴더(PC_PLUGIN_DIRS)에서 불러온 플러그인은 덮어쓸 수 없습니다");
      this.unload(man.id);
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
      return this.load(dest, false);
    } finally { if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  remove(id) {
    const st = this.plugins.get(id);
    if (!st) throw this.o.fail(404, "플러그인 없음");
    if (st.dev) throw this.o.fail(400, "개발용 폴더에서 불러온 플러그인은 지울 수 없습니다");
    this.unload(id);
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
  }
  setEnabled(id, on) {
    if (!this.plugins.has(id)) throw this.o.fail(404, "플러그인 없음");
    const all = this.settings();
    all[id] = Object.assign({}, all[id], { enabled: !!on });
    this.o.store().save();
  }
}

function cmpVer(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}
function cleanPath(p) { const s = "/" + String(p || "").replace(/^\/+/, ""); if (/\.\./.test(s.split("?")[0])) throw new Error("경로가 올바르지 않습니다"); return s.slice(0, 300); }
function cleanPanel(d) {
  if (!d || !/^[\w-]{1,40}$/.test(String(d.name || ""))) throw new Error("panel name 이 올바르지 않습니다");
  return { name: d.name, title: String(d.title || d.name).slice(0, 60), path: cleanPath(d.path || "/panel.html"), height: Math.min(4000, Math.max(80, Number(d.height) || 360)),
    sites: Array.isArray(d.sites) ? d.sites.map(String).slice(0, 20) : [] };
}
const CONN_KINDS = new Set(["fetch", "open"]);
function cleanConnector(d) {
  if (!d || !/^[\w.-]{1,60}$/.test(String(d.id || ""))) throw new Error("connector id 가 올바르지 않습니다");
  const kind = d.kind || "fetch";
  if (!CONN_KINDS.has(kind)) throw new Error("connector kind 는 fetch 또는 open 입니다");
  if (!Array.isArray(d.sites) || !d.sites.length) throw new Error("connector sites(실행할 화면 주소 접두어)가 필요합니다");
  const c = { id: d.id, kind, sites: d.sites.map(String).slice(0, 20), title: String(d.title || d.id).slice(0, 80) };
  if (d.confirm) c.confirm = String(d.confirm).slice(0, 300);
  if (kind === "open") c.url = String(d.url || "").slice(0, 2000);
  else {
    const r = d.request || {};
    c.request = { method: String(r.method || "GET").toUpperCase(), url: String(r.url || "").slice(0, 2000), headers: r.headers && typeof r.headers === "object" ? r.headers : {},
      bodyType: ["json", "form", "text", "none"].includes(r.bodyType) ? r.bodyType : (r.body === undefined ? "none" : "json"), body: r.body === undefined ? null : r.body,
      timeoutMs: Math.min(120000, Math.max(1000, Number(r.timeoutMs) || 30000)) };
    c.response = { type: d.response && d.response.type === "text" ? "text" : "json", pick: d.response && d.response.pick && typeof d.response.pick === "object" ? d.response.pick : null };
  }
  return c;
}

module.exports = { PluginHost, zipEntries, cleanConnector, cleanPanel };
