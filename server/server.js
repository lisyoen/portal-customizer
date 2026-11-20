// Portal Customizer admin server: publishes portal-customizer.json (default + scheduled layouts), contents (CMS),
// statistics, admins, backups and self update. No dependencies: Node.js 18+ only.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { Store } = require("./lib/store");
const A = require("./lib/auth");
const R = require("./lib/resolve");
const U = require("./lib/update");
const Z = require("./lib/zipinfo");
const ZW = require("./lib/zipwrite");

const VERSION = require("./package.json").version;
const DATA = path.resolve(process.env.PC_DATA || path.join(__dirname, "data"));
fs.mkdirSync(DATA, { recursive: true });
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(DATA, "config.json"), "utf8")); } catch (_e) { /* defaults */ }
const PORT = Number(process.env.PORT || config.port || 9150);
const HOST = process.env.HOST || config.host || "0.0.0.0";
const PUBLIC = path.join(__dirname, "public");
// manual and license guide shown in the console (kept in the repository's docs/ and LICENSE)
const DOC_FILES = { manual: path.join(__dirname, "..", "docs", "manual.ko.md"), license: path.join(__dirname, "..", "docs", "license.ko.md"), "license-text": path.join(__dirname, "..", "LICENSE") };
let store = new Store(DATA);
const S = () => store.data;

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "video/ogg", ".mov": "video/quicktime", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8" };
const EXT_OF = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m.split(";")[0], e]));

// ---------- helpers ----------
function send(res, code, body, headers) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ "Content-Type": isBuf ? "application/octet-stream" : typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store" }, headers || {}));
  res.end(data);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function json(req) {
  const b = await readBody(req, 50 * 1024 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString("utf8")); } catch (_e) { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
}
function cookies(req) { return Object.fromEntries(String(req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((x) => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))])); }
function baseUrl(req) {
  const fixed = S().settings.publicUrl || config.publicUrl;
  if (fixed) return fixed.replace(/\/+$/, "");
  return `http://${req.headers.host || "localhost:" + PORT}`;
}
function str(v, max) { return String(v == null ? "" : v).slice(0, max || 200); }
function now() { return new Date().toISOString(); }
function fail(status, message) { return Object.assign(new Error(message), { status }); }

// ---------- auth ----------
function currentAdmin(req) {
  const h = String(req.headers.authorization || "");
  const token = h.startsWith("Bearer ") ? h.slice(7) : cookies(req).kcs;
  if (!token) return null;
  const th = A.tokenHash(token);
  const t = S().tokens.find((x) => x.hash === th);
  if (!t) return null;
  const a = S().admins.find((x) => x.id === t.adminId && !x.disabled);
  if (!a) return null;
  if (!t.lastUsed || Date.now() - Date.parse(t.lastUsed) > 60000) { t.lastUsed = now(); store.saveSoon(); }
  return a;
}
function need(req, role) {
  const a = currentAdmin(req);
  if (!a) throw fail(401, "로그인이 필요합니다");
  if (role === "admin" && a.role !== "admin") throw fail(403, "관리자 권한이 필요합니다");
  return a;
}
const failedLogins = new Map();
function publicAdmin(a) { return { id: a.id, user: a.user, name: a.name || a.user, role: a.role, disabled: !!a.disabled, createdAt: a.createdAt, lastLogin: a.lastLogin || null }; }

// ---------- layouts ----------
function cleanLayout(obj) {
  // the extension validates every field again; here only the shape is checked
  const src = obj && obj.layout && Array.isArray(obj.layout.columns) ? obj.layout : obj;
  if (!src || !Array.isArray(src.columns) || !src.columns.length) throw fail(400, "배치(columns)가 없습니다");
  const out = { schema: 1, columns: src.columns, gaps: src.gaps };
  // widget rule picked in the extension's edit mode (container selector + level)
  const r = src.site;
  if (r && typeof r.container === "string" && r.container.trim() && Number(r.level) >= 1 && Number(r.level) <= 10) out.site = { container: r.container.trim().slice(0, 300), level: Math.round(Number(r.level)) };
  return out;
}
// Pictures and videos uploaded in the extension arrive as data: URLs; store them as media files.
function extractDataUrls(value, base, by) {
  if (typeof value === "string") {
    const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(value);
    if (m && value.length > 200) {
      const buf = Buffer.from(m[2], "base64");
      const ext = EXT_OF[m[1]] || ".bin";
      const file = A.id("m") + ext;
      fs.writeFileSync(path.join(DATA, "media", file), buf);
      return `${base}/media/${file}`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => extractDataUrls(v, base, by));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, extractDataUrls(v, base, by)]));
  return value;
}
function layoutSummary(l, t) {
  const panels = (l.layout.columns || []).reduce((n, c) => n + (c.panels || []).length, 0);
  return { id: l.id, name: l.name, note: l.note || "", isDefault: !!l.isDefault, enabled: l.enabled !== false, start: l.start || null, end: l.end || null, order: l.order || 0,
    status: R.status(l, t), columns: (l.layout.columns || []).length, panels, createdAt: l.createdAt, updatedAt: l.updatedAt, createdBy: l.createdBy, updatedBy: l.updatedBy, revisions: (l.revisions || []).length };
}
function renumber() { R.ordered(S().layouts).forEach((l, i) => { l.order = i; }); }
function findLayout(id) { const l = S().layouts.find((x) => x.id === id); if (!l) throw fail(404, "배치를 찾을 수 없습니다"); return l; }
function pushRevision(l, by) {
  l.revisions = l.revisions || [];
  l.revisions.unshift({ at: now(), by, name: l.name, layout: l.layout });
  if (l.revisions.length > 30) l.revisions.length = 30;
}
// how often (minutes) the extensions check portal-customizer.json again; published in the file itself
const DEFAULT_CLIENT_MINUTES = 5;
function clientMinutes() { const n = Math.round(Number((S().settings || {}).refreshMinutes)); return n >= 1 ? Math.min(1440, n) : DEFAULT_CLIENT_MINUTES; }
function published(t) {
  const r = R.resolve(S().layouts, t);
  if (!r.layout) return null;
  const l = r.layout;
  const refreshMinutes = clientMinutes();
  const st0 = S().settings || {};
  const version = crypto.createHash("sha1").update(l.id + "|" + l.updatedAt + "|" + refreshMinutes + "|" + JSON.stringify(st0.siteMatch || [])).digest("hex").slice(0, 12);
  const st = S().settings || {};
  const out = { schema: 1, version, name: l.name, refreshMinutes, match: st.siteMatch || [], columns: l.layout.columns, gaps: l.layout.gaps, publishedBy: "portal-customizer-server", layoutId: l.id, reason: r.reason };
  if (l.layout.site) out.site = l.layout.site; // widget rule saved with the layout in the extension
  return out;
}

// ---------- installations (one per extension install, by its anonymous id) ----------
// last time each installation fetched the layout, its version, browser and address, and the name, person in charge
// and note an administrator gives it, so installations that stopped checking in (extension turned off,
// PC off or gone) can be found and looked after (e.g. meeting room PCs).
const DEFAULT_INACTIVE_DAYS = 3;
function clientsMap() { const d = S(); if (!d.clients || typeof d.clients !== "object") d.clients = {}; return d.clients; }
function browserOf(ua) { ua = String(ua || ""); return /Edg\//.test(ua) ? "Edge" : /Whale\//.test(ua) ? "Whale" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : ua ? "기타" : ""; }
function osOf(ua) { ua = String(ua || ""); return /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : ""; }
function clientIp(req) {
  const f = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return str(f || (req.socket && req.socket.remoteAddress) || "", 60).replace(/^::ffff:/, "");
}
function seeClient(req, id) {
  if (!/^[\w-]{8,40}$/.test(id)) return;
  const all = clientsMap();
  let c = all[id];
  if (!c) {
    const ids = Object.keys(all);
    if (ids.length >= 20000) { // drop the oldest unnamed installation
      const old = ids.filter((k) => !all[k].name).sort((a, b) => String(all[a].lastSeen).localeCompare(String(all[b].lastSeen)))[0];
      if (old) delete all[old]; else return;
    }
    c = all[id] = { id, firstSeen: now() };
  }
  c.lastSeen = now();
  c.version = str(req.headers["x-pc-version"], 20) || c.version || "";
  const ua = req.headers["user-agent"];
  c.browser = browserOf(ua) || c.browser || ""; c.os = osOf(ua) || c.os || "";
  c.ip = clientIp(req) || c.ip || "";
}
function inactiveDays() { return Math.max(1, Number((S().settings || {}).inactiveDays) || DEFAULT_INACTIVE_DAYS); }

// ---------- stats ----------
function day(d) { return (d || new Date()).toISOString().slice(0, 10); }
function recordFetch(req, servedId) {
  const k = day(); const st = S().stats;
  const d = st[k] || (st[k] = { req: 0, clients: {}, versions: {}, served: {} });
  d.req += 1;
  const client = str(req.headers["x-pc-client"], 40);
  if (client) { d.clients[client] = 1; seeClient(req, client); }
  const ver = str(req.headers["x-pc-version"], 20) || "unknown";
  d.versions[ver] = (d.versions[ver] || 0) + 1;
  if (servedId) d.served[servedId] = (d.served[servedId] || 0) + 1;
  const keys = Object.keys(st).sort();
  while (keys.length > 180) delete st[keys.shift()];
  store.saveSoon();
}

// ---------- files ----------
function serveFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "not found");
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": cache || "no-cache", "Access-Control-Allow-Origin": "*" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range) {
      let start = range[1] === "" ? st.size - Number(range[2]) : Number(range[1]);
      let end = range[1] === "" || range[2] === "" ? st.size - 1 : Number(range[2]);
      if (start < 0 || start >= st.size || end < start) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, Object.assign(headers, { "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 }));
      return req.method === "HEAD" ? res.end() : fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, Object.assign(headers, { "Content-Length": st.size }));
    return req.method === "HEAD" ? res.end() : fs.createReadStream(file).pipe(res);
  });
}
function safeName(name) { return path.basename(String(name || "")).replace(/[^\w.\-가-힣]/g, "_").slice(0, 120); }

// ---------- routes ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_m, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, handler });
}

// ---------- extension distribution: packages uploaded by an administrator, served to the extensions ----------
const EXT_DIR = path.join(DATA, "ext");
fs.mkdirSync(EXT_DIR, { recursive: true });
const EXT_CORS = { "Access-Control-Allow-Origin": "*" };
function extState() { const d = S(); if (!d.extension) d.extension = { current: "", releases: [] }; return d.extension; }
function extFile(v) { return `portal-customizer-v${v}.zip`; }
route("GET", "/ext/latest.json", (req, res) => {
  const e = extState(); const r = e.releases.find((x) => x.version === e.current);
  if (!r) return send(res, 404, { error: "배포 중인 확장 패키지가 없습니다" }, EXT_CORS);
  return send(res, 200, { version: r.version, zipUrl: `${baseUrl(req)}/ext/${extFile(r.version)}`, notes: r.notes || "", publishedAt: r.publishedAt || r.uploadedAt, source: "portal-customizer-server" }, EXT_CORS);
});
// The packages are handed out with this server's connection settings written into config.json, so an extension
// installed from here (first install or update) already knows its organization address and update server.
function extConfig(req) {
  const base = baseUrl(req);
  return { orgConfigUrl: base + "/portal-customizer.json", adminServer: base, updateSource: "server",
    siteName: (S().settings || {}).siteName || "", issuedBy: "portal-customizer-server v" + VERSION, issuedAt: now() };
}
const injected = new Map(); // file|mtime|base -> buffer
function extPackage(req, file) {
  const fp = path.join(EXT_DIR, file);
  const st = fs.statSync(fp);
  const cfg = extConfig(req);
  const key = [file, st.mtimeMs, cfg.orgConfigUrl, cfg.siteName].join("|");
  if (!injected.has(key)) {
    for (const k of injected.keys()) if (k.startsWith(file + "|")) injected.delete(k);
    const { issuedAt, ...stable } = cfg; // eslint-disable-line no-unused-vars
    injected.set(key, ZW.putEntry(fs.readFileSync(fp), "config.json", JSON.stringify(Object.assign(stable, { issuedAt: new Date(st.mtimeMs).toISOString() }), null, 2) + "\n"));
  }
  return injected.get(key);
}
function sendZip(res, buf, name) {
  res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": buf.length, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
  res.end(buf);
}
// installation package for new users: the version being distributed, with this server's settings
route("GET", "/ext/install.zip", (req, res) => {
  const e = extState(); const r = e.releases.find((x) => x.version === e.current);
  if (!r || !fs.existsSync(path.join(EXT_DIR, extFile(r.version)))) return send(res, 404, { error: "배포 중인 확장 패키지가 없습니다" }, EXT_CORS);
  return sendZip(res, extPackage(req, extFile(r.version)), `portal-customizer-v${r.version}-install.zip`);
});
route("GET", "/ext/:file", (req, res, p) => {
  const f = safeName(p.file);
  if (!/^portal-customizer-v\d+\.\d+\.\d+\.zip$/.test(f) || !fs.existsSync(path.join(EXT_DIR, f))) return send(res, 404, { error: "없는 파일입니다" }, EXT_CORS);
  return sendZip(res, extPackage(req, f), f);
});
route("GET", "/api/extension", (req) => { need(req); const e = extState(); return { current: e.current, releases: e.releases.slice().sort((a, b) => U.cmpVer(b.version, a.version)), latestUrl: "/ext/latest.json", installUrl: "/ext/install.zip", notice: (S().settings || {}).welcomeNotice || "", config: extConfig(req), github: { release: GITHUB_RELEASES } }; });
route("PUT", "/api/extension", async (req, res, p, q) => {
  const a = need(req, "admin");
  const body = await readBody(req, 100 * 1024 * 1024);
  return saveExtPackage(a, body, { notes: str(q.get("notes"), 2000), publish: q.get("publish") !== "0" });
});
// Newest release from GitHub: the server downloads it itself (direct, then curl, which follows the proxy
// environment). When this server cannot reach GitHub, the page tells the administrator to download it in the
// browser and upload it (two steps).
const GITHUB_REPO = "lisyoen/portal-customizer";
// PC_GITHUB_LATEST: another latest.json address (tests, or a mirror the server can reach)
const GITHUB_LATEST = process.env.PC_GITHUB_LATEST || `https://raw.githubusercontent.com/${GITHUB_REPO}/main/publish/latest.json`;
const GITHUB_RELEASES = `https://github.com/${GITHUB_REPO}/releases/latest`;
async function download(url, max) {
  let directErr = "";
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000), headers: { "User-Agent": "portal-customizer-server" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > max) throw new Error("too large");
    return b;
  } catch (e) { directErr = String(e.message || e); }
  const out = await new Promise((resolve) => {
    require("child_process").execFile("curl", ["-fsSL", "--max-time", "60", url], { encoding: "buffer", maxBuffer: max }, (err, stdout, stderr) =>
      resolve(err ? { error: String(stderr || err.message).trim().slice(-200) } : { buf: stdout }));
  });
  if (out.buf && out.buf.length) return out.buf;
  throw new Error(`직접 연결 실패(${directErr}), curl 실패(${out.error || "응답 없음"})`);
}
route("POST", "/api/extension/github", async (req, res, p, q) => {
  const a = need(req, "admin");
  let info, body;
  try {
    info = JSON.parse((await download(GITHUB_LATEST, 1024 * 1024)).toString("utf8"));
    if (!/^\d+\.\d+\.\d+$/.test(String(info.version || "")) || !(process.env.PC_GITHUB_LATEST ? /^https?:\/\//.test(String(info.zipUrl || "")) : /^https:\/\/github\.com\//.test(String(info.zipUrl || "")))) throw new Error("최신 버전 정보가 올바르지 않습니다");
    const have = extState().releases.find((x) => x.version === info.version);
    if (have && fs.existsSync(path.join(EXT_DIR, extFile(info.version))) && q.get("force") !== "1") {
      const e = extState();
      if (q.get("publish") !== "0" && e.current !== info.version) { e.current = info.version; have.publishedAt = now(); store.audit(a.user, "확장 배포 버전 변경", "v" + info.version); store.save(); }
      return { release: have, current: e.current, already: true };
    }
    body = await download(info.zipUrl, 100 * 1024 * 1024);
  } catch (e) {
    throw fail(502, "서버가 GitHub 에서 받지 못했습니다: " + String(e.message || e) + ". 아래 2단계 방법(브라우저로 받아서 올리기)을 쓰세요.");
  }
  return saveExtPackage(a, body, { notes: str(q.get("notes"), 2000) || `GitHub 릴리스 v${info.version}`, publish: q.get("publish") !== "0", source: "github" });
});
function saveExtPackage(a, body, opts) {
  let manifest;
  try { const m = Z.readEntry(body, "manifest.json"); if (!m) throw new Error("zip 맨 위에 manifest.json 이 없습니다. GitHub 릴리스의 portal-customizer-vX.Y.Z.zip 을 올리세요"); manifest = JSON.parse(m.toString("utf8")); }
  catch (e) { throw fail(400, "확장 패키지를 읽지 못했습니다: " + e.message); }
  const v = String(manifest.version || "");
  if (!/^\d+\.\d+\.\d+$/.test(v) || !manifest.manifest_version) throw fail(400, "manifest.json 의 버전이 올바르지 않습니다");
  if (!/portal customizer/i.test(String(manifest.name || "")) && !/__MSG_/.test(String(manifest.name || ""))) throw fail(400, "Portal Customizer 확장 패키지가 아닙니다");
  fs.writeFileSync(path.join(EXT_DIR, extFile(v)), body);
  const e = extState();
  e.releases = e.releases.filter((x) => x.version !== v);
  const rel = { version: v, size: body.length, notes: opts.notes || "", uploadedAt: now(), by: a.user, source: opts.source || "upload" };
  e.releases.push(rel);
  if (opts.publish) { e.current = v; rel.publishedAt = now(); }
  store.audit(a.user, opts.source === "github" ? "확장 패키지 GitHub 받기" : "확장 패키지 업로드", "v" + v + (opts.publish ? " (배포)" : "")); store.save();
  return { release: rel, current: e.current };
}
route("POST", "/api/extension/:version/publish", (req, res, p) => {
  const a = need(req, "admin"); const e = extState(); const r = e.releases.find((x) => x.version === p.version);
  if (!r || !fs.existsSync(path.join(EXT_DIR, extFile(r.version)))) throw fail(404, "패키지를 찾을 수 없습니다");
  e.current = r.version; r.publishedAt = now(); store.audit(a.user, "확장 배포 버전 변경", "v" + r.version); store.save(); return { current: e.current };
});
route("POST", "/api/extension/unpublish", (req) => { const a = need(req, "admin"); extState().current = ""; store.audit(a.user, "확장 배포 중지"); store.save(); return { current: "" }; });
route("DELETE", "/api/extension/:version", (req, res, p) => {
  const a = need(req, "admin"); const e = extState();
  if (e.current === p.version) throw fail(400, "배포 중인 버전은 지울 수 없습니다");
  e.releases = e.releases.filter((x) => x.version !== p.version);
  fs.rmSync(path.join(EXT_DIR, extFile(safeName(p.version))), { force: true });
  store.audit(a.user, "확장 패키지 삭제", "v" + p.version); store.save(); return { ok: true };
});

route("GET", "/api/docs/:name", (req, res, p) => {
  need(req);
  const f = Object.prototype.hasOwnProperty.call(DOC_FILES, p.name) ? DOC_FILES[p.name] : null;
  if (!f || !fs.existsSync(f)) throw fail(404, "문서가 없습니다");
  return { name: p.name, text: fs.readFileSync(f, "utf8") };
});
route("GET", "/api/health", () => ({ ok: true, version: VERSION, siteName: (S().settings || {}).siteName || "Portal Customizer" }));

route("GET", "/portal-customizer.json", (req, res, p, q) => {
  const t = q.get("at") ? Date.parse(q.get("at")) : Date.now();
  const out = published(t);
  if (!q.get("at")) recordFetch(req, out && out.layoutId);
  if (!out) return send(res, 404, { error: "게시된 배치가 없습니다" }, { "Access-Control-Allow-Origin": "*" });
  // the name an administrator gave this installation, so it can be shown in its popup; the notice for the
  // extension's guide page
  const c = clientsMap()[str(req.headers["x-pc-client"], 40)];
  const notice = str((S().settings || {}).welcomeNotice, 2000);
  const extra = {};
  if (c && c.name) extra.client = { name: c.name };
  if (notice) extra.notice = notice;
  return send(res, 200, Object.keys(extra).length ? Object.assign({}, out, extra) : out, { "Access-Control-Allow-Origin": "*" });
});

route("POST", "/api/login", async (req, res) => {
  const b = await json(req);
  const ip = req.socket.remoteAddress;
  const f = failedLogins.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) throw fail(429, "로그인 시도가 많습니다. 잠시 후 다시 시도하세요");
  const a = S().admins.find((x) => x.user === str(b.user, 60) && !x.disabled);
  if (!a || !A.verifyPassword(str(b.password, 200), a.salt, a.hash)) {
    f.n += 1; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } failedLogins.set(ip, f);
    store.audit(str(b.user, 60), "로그인 실패", "", ip); store.saveSoon();
    throw fail(401, "아이디 또는 비밀번호가 맞지 않습니다");
  }
  failedLogins.delete(ip);
  const token = A.newToken();
  S().tokens.push({ hash: A.tokenHash(token), adminId: a.id, createdAt: now(), lastUsed: now(), label: str(b.label || "web", 60) });
  if (S().tokens.length > 500) S().tokens.splice(0, S().tokens.length - 500);
  a.lastLogin = now();
  store.audit(a.user, "로그인", str(b.label || "web", 60), ip); store.save();
  return send(res, 200, { token, admin: publicAdmin(a) }, { "Set-Cookie": `kcs=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}` });
});
route("POST", "/api/logout", (req, res) => {
  const h = String(req.headers.authorization || "");
  const token = h.startsWith("Bearer ") ? h.slice(7) : cookies(req).kcs;
  if (token) { const th = A.tokenHash(token); S().tokens = S().tokens.filter((x) => x.hash !== th); store.save(); }
  return send(res, 200, { ok: true }, { "Set-Cookie": "kcs=; Path=/; Max-Age=0" });
});
route("GET", "/api/me", (req) => ({ admin: publicAdmin(need(req)), version: VERSION, publicUrl: S().settings.publicUrl || "" }));
route("POST", "/api/me/password", async (req) => {
  const a = need(req); const b = await json(req);
  if (!A.verifyPassword(str(b.current, 200), a.salt, a.hash)) throw fail(400, "현재 비밀번호가 맞지 않습니다");
  if (str(b.password, 200).length < 8) throw fail(400, "새 비밀번호는 8자 이상이어야 합니다");
  Object.assign(a, A.hashPassword(b.password)); store.audit(a.user, "비밀번호 변경", a.user); store.save();
  return { ok: true };
});

// layouts
route("GET", "/api/layouts", (req) => { need(req); const t = Date.now(); const cur = R.resolve(S().layouts, t);
  return { layouts: R.ordered(S().layouts).map((l) => layoutSummary(l, t)), current: cur.layout ? cur.layout.id : null, reason: cur.reason }; });
route("POST", "/api/layouts", async (req) => {
  const a = need(req); const b = await json(req);
  const name = str(b.name, 100).trim() || "배치 " + new Date().toLocaleString("ko-KR");
  const layout = extractDataUrls(cleanLayout(b.layout || b), baseUrl(req), a.user);
  const l = { id: A.id("l"), name, note: str(b.note, 1000), layout, isDefault: false, enabled: true, start: null, end: null, order: 1e9, createdAt: now(), updatedAt: now(), createdBy: a.user, updatedBy: a.user, revisions: [] };
  if (!S().layouts.length) l.isDefault = true;
  S().layouts.push(l); renumber(); store.audit(a.user, "배치 등록", name, b.source || ""); store.save();
  return { layout: layoutSummary(l, Date.now()) };
});
route("GET", "/api/layouts/:id", (req, res, p) => { need(req); const l = findLayout(p.id); return Object.assign(layoutSummary(l, Date.now()), { layout: l.layout }); });
route("PUT", "/api/layouts/:id", async (req, res, p) => {
  const a = need(req); const b = await json(req); const l = findLayout(p.id);
  if (b.layout) { pushRevision(l, a.user); l.layout = extractDataUrls(cleanLayout(b.layout), baseUrl(req), a.user); }
  if ("name" in b) l.name = str(b.name, 100).trim() || l.name;
  if ("note" in b) l.note = str(b.note, 1000);
  if ("enabled" in b) l.enabled = !!b.enabled;
  for (const k of ["start", "end"]) if (k in b) { const v = b[k] ? new Date(b[k]) : null; if (v && isNaN(v)) throw fail(400, "날짜 형식이 올바르지 않습니다"); l[k] = v ? v.toISOString() : null; }
  if (l.start && l.end && l.start >= l.end) throw fail(400, "공개 종료가 시작보다 뒤여야 합니다");
  l.updatedAt = now(); l.updatedBy = a.user;
  store.audit(a.user, b.layout ? "배치 수정" : "배치 설정 변경", l.name); store.save();
  return { layout: layoutSummary(l, Date.now()) };
});
route("DELETE", "/api/layouts/:id", (req, res, p) => {
  const a = need(req); const l = findLayout(p.id);
  if (l.isDefault && S().layouts.length > 1) throw fail(400, "기본 배치는 삭제할 수 없습니다. 다른 배치를 기본으로 지정한 뒤 삭제하세요");
  S().layouts = S().layouts.filter((x) => x.id !== l.id); renumber(); store.audit(a.user, "배치 삭제", l.name); store.save();
  return { ok: true };
});
route("POST", "/api/layouts/:id/default", (req, res, p) => {
  const a = need(req); const l = findLayout(p.id);
  S().layouts.forEach((x) => { x.isDefault = x.id === l.id; }); l.enabled = true; l.start = null; l.end = null; l.updatedAt = now();
  renumber(); store.audit(a.user, "기본 배치 지정", l.name); store.save();
  return { ok: true };
});
route("POST", "/api/layouts/order", async (req) => {
  const a = need(req); const b = await json(req); const ids = Array.isArray(b.ids) ? b.ids : [];
  ids.forEach((id, i) => { const l = S().layouts.find((x) => x.id === id); if (l) l.order = i + 1; });
  renumber(); store.audit(a.user, "우선순위 변경", ids.length + "건"); store.save();
  return { ok: true };
});
route("POST", "/api/layouts/:id/duplicate", (req, res, p) => {
  const a = need(req); const l = findLayout(p.id);
  const c = { id: A.id("l"), name: l.name + " (복사)", note: l.note, layout: JSON.parse(JSON.stringify(l.layout)), isDefault: false, enabled: true, start: null, end: null,
    order: l.order + 0.5, createdAt: now(), updatedAt: now(), createdBy: a.user, updatedBy: a.user, revisions: [] };
  S().layouts.push(c); renumber(); store.audit(a.user, "배치 복사", c.name); store.save();
  return { layout: layoutSummary(c, Date.now()) };
});
route("GET", "/api/layouts/:id/revisions", (req, res, p) => { need(req); const l = findLayout(p.id); return { revisions: (l.revisions || []).map((r, i) => ({ index: i, at: r.at, by: r.by, name: r.name })) }; });
route("POST", "/api/layouts/:id/restore", async (req, res, p) => {
  const a = need(req); const b = await json(req); const l = findLayout(p.id); const r = (l.revisions || [])[Number(b.index)];
  if (!r) throw fail(404, "이력이 없습니다");
  const back = r.layout; pushRevision(l, a.user); l.layout = back; l.updatedAt = now(); l.updatedBy = a.user;
  store.audit(a.user, "배치 되돌리기", l.name, r.at); store.save();
  return { ok: true };
});
route("GET", "/api/timeline", (req, res, p, q) => {
  need(req); const from = q.get("from") ? Date.parse(q.get("from")) : Date.now(); const to = q.get("to") ? Date.parse(q.get("to")) : from + 30 * 864e5;
  return { from, to, segments: R.timeline(S().layouts, from, to) };
});
route("GET", "/api/preview", (req, res, p, q) => { need(req); const t = q.get("at") ? Date.parse(q.get("at")) : Date.now(); return { at: t, published: published(t) }; });

// contents (CMS)
route("GET", "/api/groups", (req) => { need(req); return { groups: S().groups.map((g) => Object.assign({}, g, { count: S().contents.filter((c) => c.groupId === g.id).length })) }; });
route("POST", "/api/groups", async (req) => { const a = need(req); const b = await json(req); const g = { id: A.id("g"), name: str(b.name, 60).trim() || "새 그룹", createdAt: now() };
  S().groups.push(g); store.audit(a.user, "그룹 추가", g.name); store.save(); return { group: g }; });
route("PUT", "/api/groups/:id", async (req, res, p) => { const a = need(req); const b = await json(req); const g = S().groups.find((x) => x.id === p.id); if (!g) throw fail(404, "그룹 없음");
  g.name = str(b.name, 60).trim() || g.name; store.audit(a.user, "그룹 이름 변경", g.name); store.save(); return { group: g }; });
route("DELETE", "/api/groups/:id", (req, res, p) => { const a = need(req); const g = S().groups.find((x) => x.id === p.id); if (!g) throw fail(404, "그룹 없음");
  S().contents.forEach((c) => { if (c.groupId === g.id) c.groupId = null; }); S().groups = S().groups.filter((x) => x.id !== g.id); store.audit(a.user, "그룹 삭제", g.name); store.save(); return { ok: true }; });
const CTYPES = ["image", "video", "text", "html", "link"];
function cleanContent(b, c) {
  const out = c || {};
  if ("type" in b) { if (!CTYPES.includes(b.type)) throw fail(400, "콘텐츠 종류가 올바르지 않습니다"); out.type = b.type; }
  for (const [k, n] of [["title", 200], ["text", 20000], ["html", 100000], ["url", 2000], ["link", 2000], ["poster", 2000], ["tags", 300]]) if (k in b) out[k] = str(b[k], n);
  if ("groupId" in b) out.groupId = b.groupId && S().groups.some((g) => g.id === b.groupId) ? b.groupId : null;
  return out;
}
route("GET", "/api/contents", (req, res, p, q) => { need(req); const g = q.get("group"); const t = q.get("type"); const s = (q.get("q") || "").toLowerCase();
  return { contents: S().contents.filter((c) => (!g || (g === "none" ? !c.groupId : c.groupId === g)) && (!t || c.type === t) && (!s || (c.title + " " + (c.tags || "") + " " + (c.text || "")).toLowerCase().includes(s))) }; });
route("POST", "/api/contents", async (req) => { const a = need(req); const b = await json(req);
  const c = cleanContent(b, { id: A.id("c"), createdAt: now(), createdBy: a.user });
  if (!c.type) throw fail(400, "콘텐츠 종류가 필요합니다");
  c.updatedAt = now(); S().contents.unshift(c); store.audit(a.user, "콘텐츠 등록", c.title || c.type); store.save(); return { content: c }; });
route("PUT", "/api/contents/:id", async (req, res, p) => { const a = need(req); const b = await json(req); const c = S().contents.find((x) => x.id === p.id); if (!c) throw fail(404, "콘텐츠 없음");
  cleanContent(b, c); c.updatedAt = now(); store.audit(a.user, "콘텐츠 수정", c.title || c.type); store.save(); return { content: c }; });
route("DELETE", "/api/contents/:id", (req, res, p) => { const a = need(req); const c = S().contents.find((x) => x.id === p.id); if (!c) throw fail(404, "콘텐츠 없음");
  S().contents = S().contents.filter((x) => x.id !== c.id); store.audit(a.user, "콘텐츠 삭제", c.title || c.type); store.save(); return { ok: true }; });
route("PUT", "/api/upload", async (req, res, p, q) => {
  const a = need(req);
  const body = await readBody(req, 500 * 1024 * 1024);
  if (!body.length) throw fail(400, "파일이 비어 있습니다");
  const orig = safeName(q.get("name") || "file");
  let ext = path.extname(orig).toLowerCase();
  if (!MIME[ext]) ext = EXT_OF[String(req.headers["content-type"] || "").split(";")[0]] || ".bin";
  const file = A.id("m") + ext;
  fs.writeFileSync(path.join(DATA, "media", file), body);
  store.audit(a.user, "파일 업로드", orig, String(body.length)); store.saveSoon();
  return { file, name: orig, size: body.length, mime: MIME[ext] || "application/octet-stream", url: `${baseUrl(req)}/media/${file}` };
});
route("GET", "/api/media", (req) => { need(req);
  const used = JSON.stringify(S().layouts.map((l) => l.layout)) + JSON.stringify(S().contents);
  return { files: fs.readdirSync(path.join(DATA, "media")).map((f) => { const st = fs.statSync(path.join(DATA, "media", f)); return { file: f, size: st.size, at: st.mtime, used: used.includes("/media/" + f) }; }) }; });
route("DELETE", "/api/media/:file", (req, res, p) => { const a = need(req); const f = safeName(p.file); fs.rmSync(path.join(DATA, "media", f), { force: true }); store.audit(a.user, "파일 삭제", f); store.save(); return { ok: true }; });

// stats
route("GET", "/api/stats", (req, res, p, q) => {
  need(req); const days = Math.min(180, Number(q.get("days")) || 30); const out = [];
  const names = Object.fromEntries(S().layouts.map((l) => [l.id, l.name]));
  const versions = {}; const served = {}; const allClients = new Set();
  for (let i = days - 1; i >= 0; i -= 1) {
    const k = day(new Date(Date.now() - i * 864e5)); const d = S().stats[k] || { req: 0, clients: {}, versions: {}, served: {} };
    out.push({ day: k, req: d.req, users: Object.keys(d.clients).length });
    Object.keys(d.clients).forEach((c) => allClients.add(c));
    for (const [v, n] of Object.entries(d.versions)) versions[v] = (versions[v] || 0) + n;
    for (const [v, n] of Object.entries(d.served)) served[names[v] || v] = (served[names[v] || v] || 0) + n;
  }
  return { days: out, users: allClients.size, versions, served };
});

// installations
function publicClient(c, limit) {
  const since = c.lastSeen ? Math.floor((Date.now() - Date.parse(c.lastSeen)) / 864e5) : null;
  return Object.assign({}, c, { idleDays: since, inactive: since != null && since >= limit });
}
route("GET", "/api/clients", (req) => {
  need(req); const limit = inactiveDays();
  const list = Object.values(clientsMap()).map((c) => publicClient(c, limit));
  // watched and inactive first, then by name, then most recently seen
  list.sort((a, b) => (b.inactive && b.watch) - (a.inactive && a.watch) || (!!b.name) - (!!a.name) || String(a.name || "").localeCompare(String(b.name || "")) || String(b.lastSeen).localeCompare(String(a.lastSeen)));
  return { clients: list, inactiveDays: limit, total: list.length, inactive: list.filter((c) => c.inactive).length, watchedInactive: list.filter((c) => c.inactive && c.watch).length };
});
route("PUT", "/api/clients/:id", async (req, res, p) => {
  const a = need(req); const b = await json(req); const id = str(p.id, 40);
  if (!/^[\w-]{8,40}$/.test(id)) throw fail(400, "설치 ID 가 올바르지 않습니다");
  const all = clientsMap();
  const c = all[id] || (all[id] = { id, firstSeen: now() });
  if ("name" in b) c.name = str(b.name, 60).trim();
  if ("owner" in b) c.owner = str(b.owner, 60).trim();
  if ("note" in b) c.note = str(b.note, 300).trim();
  if ("watch" in b) c.watch = !!b.watch;
  c.updatedBy = a.user; c.updatedAt = now();
  store.audit(a.user, "설치 PC 정보 변경", c.name || id.slice(0, 8)); store.save();
  return { client: publicClient(c, inactiveDays()) };
});
route("DELETE", "/api/clients/:id", (req, res, p) => {
  const a = need(req, "admin"); const all = clientsMap(); const c = all[str(p.id, 40)];
  if (!c) throw fail(404, "없는 설치입니다");
  delete all[c.id]; store.audit(a.user, "설치 PC 삭제", c.name || c.id.slice(0, 8)); store.save(); return { ok: true };
});

// admins & audit
route("GET", "/api/admins", (req) => { need(req, "admin"); return { admins: S().admins.map(publicAdmin) }; });
route("POST", "/api/admins", async (req) => { const a = need(req, "admin"); const b = await json(req); const user = str(b.user, 60).trim();
  if (!/^[\w.@-]{2,60}$/.test(user)) throw fail(400, "아이디는 영문·숫자·._@- 2~60자"); if (S().admins.some((x) => x.user === user)) throw fail(400, "이미 있는 아이디입니다");
  if (str(b.password, 200).length < 8) throw fail(400, "비밀번호는 8자 이상이어야 합니다");
  const n = Object.assign({ id: A.id("a"), user, name: str(b.name, 60) || user, role: b.role === "editor" ? "editor" : "admin", createdAt: now() }, A.hashPassword(b.password));
  S().admins.push(n); store.audit(a.user, "관리자 추가", user, n.role); store.save(); return { admin: publicAdmin(n) }; });
route("PUT", "/api/admins/:id", async (req, res, p) => { const a = need(req, "admin"); const b = await json(req); const t = S().admins.find((x) => x.id === p.id); if (!t) throw fail(404, "관리자 없음");
  if ("name" in b) t.name = str(b.name, 60);
  if ("role" in b) t.role = b.role === "editor" ? "editor" : "admin";
  if ("disabled" in b) t.disabled = !!b.disabled;
  if (b.password) { if (str(b.password, 200).length < 8) throw fail(400, "비밀번호는 8자 이상이어야 합니다"); Object.assign(t, A.hashPassword(b.password)); S().tokens = S().tokens.filter((x) => x.adminId !== t.id); }
  if (!S().admins.some((x) => x.role === "admin" && !x.disabled)) throw fail(400, "관리자(admin) 계정이 하나 이상 있어야 합니다");
  store.audit(a.user, "관리자 수정", t.user); store.save(); return { admin: publicAdmin(t) }; });
route("DELETE", "/api/admins/:id", (req, res, p) => { const a = need(req, "admin"); const t = S().admins.find((x) => x.id === p.id); if (!t) throw fail(404, "관리자 없음");
  if (t.id === a.id) throw fail(400, "자기 계정은 삭제할 수 없습니다");
  S().admins = S().admins.filter((x) => x.id !== t.id); S().tokens = S().tokens.filter((x) => x.adminId !== t.id); store.audit(a.user, "관리자 삭제", t.user); store.save(); return { ok: true }; });
route("GET", "/api/audit", (req, res, p, q) => { need(req, "admin"); const n = Math.min(1000, Number(q.get("limit")) || 200); return { audit: S().audit.slice(0, n) }; });

// settings
route("GET", "/api/settings", (req) => { need(req); return { settings: Object.assign({ autoUpdate: true, checkMinutes: 1, refreshMinutes: DEFAULT_CLIENT_MINUTES, siteName: "Portal Customizer", inactiveDays: DEFAULT_INACTIVE_DAYS, welcomeNotice: "" }, S().settings), version: VERSION, port: PORT }; });
route("PUT", "/api/settings", async (req) => { const a = need(req, "admin"); const b = await json(req); const s = S().settings;
  if ("publicUrl" in b) { const v = str(b.publicUrl, 300).trim().replace(/\/+$/, ""); if (v && !/^https?:\/\/[^/]+$/.test(v)) throw fail(400, "서버 주소는 http(s)://주소:포트 형식이어야 합니다"); s.publicUrl = v; }
  if ("autoUpdate" in b) s.autoUpdate = !!b.autoUpdate;
  if ("checkMinutes" in b) { s.checkMinutes = Math.min(10080, Math.max(1, Math.round(Number(b.checkMinutes)) || 1)); delete s.checkHours; }
  if ("refreshMinutes" in b) s.refreshMinutes = Math.min(1440, Math.max(1, Math.round(Number(b.refreshMinutes)) || DEFAULT_CLIENT_MINUTES));
  if ("siteName" in b) s.siteName = str(b.siteName, 60);
  if ("inactiveDays" in b) s.inactiveDays = Math.min(365, Math.max(1, Math.round(Number(b.inactiveDays)) || DEFAULT_INACTIVE_DAYS));
  if ("welcomeNotice" in b) s.welcomeNotice = str(b.welcomeNotice, 2000).trim();
  // pages the layout applies to (address prefixes, * = anything) and the optional site rule (CSS selectors)
  if ("siteMatch" in b) {
    const list = (Array.isArray(b.siteMatch) ? b.siteMatch : String(b.siteMatch || "").split(/[\s,]+/)).map((x) => str(x, 300).trim()).filter(Boolean);
    const bad = list.find((x) => !/^https?:\/\/[^\s]+$/.test(x));
    if (bad) throw fail(400, "적용할 화면 주소는 http(s):// 로 시작해야 합니다: " + bad);
    s.siteMatch = list.slice(0, 50);
  }
  if ("siteRule" in b) delete s.siteRule; // selectors are no longer set on the server (picked in the extension)
  store.audit(a.user, "설정 변경", Object.keys(b).join(",")); store.save(); return { settings: s }; });

// update
let lastCheck = null;
function checkMinutes() { const st = S().settings || {}; return Math.max(1, Number(st.checkMinutes) || (st.checkHours ? st.checkHours * 60 : 1)); }
async function checkUpdate() { const r = await U.latestRemote(); lastCheck = Object.assign({ at: now(), current: VERSION, newer: !!(r.latest && U.cmpVer(r.latest, VERSION) > 0) }, r); return lastCheck; }
const RELEASES = "https://github.com/lisyoen/portal-customizer/releases";
route("GET", "/api/update", (req) => { need(req); return { current: VERSION, check: lastCheck, status: U.readStatus(DATA), releases: RELEASES, releaseUrl: RELEASES + "/tag/" + U.PREFIX + VERSION, checkMinutes: checkMinutes() }; });
route("POST", "/api/update/check", async (req) => { need(req, "admin"); return checkUpdate(); });
route("POST", "/api/update/apply", async (req) => { const a = need(req, "admin"); const b = await json(req); const c = lastCheck && lastCheck.latest ? lastCheck : await checkUpdate();
  const v = str(b.version || c.latest, 20); if (!v || U.cmpVer(v, VERSION) <= 0) throw fail(400, "새 버전이 없습니다");
  store.audit(a.user, "업데이트 시작", "v" + v); store.flush(); return U.apply(DATA, v); });
route("PUT", "/api/update/package", async (req) => { const a = need(req, "admin"); const body = await readBody(req, 300 * 1024 * 1024);
  const dir = path.join(DATA, "update"); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, "upload-" + Date.now() + ".tar.gz"); fs.writeFileSync(file, body);
  store.audit(a.user, "업데이트 패키지 업로드", String(body.length)); store.flush();
  const r = await U.installPackage(DATA, file, VERSION); if (!r.ok) throw fail(400, r.error); return r; });

// backup / restore: tar.gz of db.json + media
route("GET", "/api/backup", (req, res) => {
  const a = need(req, "admin"); store.flush(); store.audit(a.user, "백업 내려받기"); store.saveSoon();
  res.writeHead(200, { "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="portal-customizer-server-backup-${day()}.tar.gz"` });
  const { spawn } = require("child_process");
  const p = spawn("tar", ["czf", "-", "-C", DATA, "db.json", "media"]);
  p.stdout.pipe(res);
});
route("PUT", "/api/backup", async (req) => {
  const a = need(req, "admin"); const body = await readBody(req, 2 * 1024 * 1024 * 1024);
  const tmp = fs.mkdtempSync(path.join(DATA, "restore-")); const file = path.join(tmp, "b.tar.gz"); fs.writeFileSync(file, body);
  await new Promise((resolve, reject) => execFile("tar", ["xzf", file, "-C", tmp], (e) => (e ? reject(fail(400, "백업 파일을 풀지 못했습니다")) : resolve())));
  let d; try { d = JSON.parse(fs.readFileSync(path.join(tmp, "db.json"), "utf8")); } catch (_e) { throw fail(400, "db.json 이 없는 백업입니다"); }
  if (!Array.isArray(d.layouts) || !Array.isArray(d.admins) || !d.admins.length) throw fail(400, "올바른 백업이 아닙니다");
  store.flush(); fs.copyFileSync(path.join(DATA, "db.json"), path.join(DATA, `db-before-restore-${Date.now()}.json`));
  fs.copyFileSync(path.join(tmp, "db.json"), path.join(DATA, "db.json"));
  if (fs.existsSync(path.join(tmp, "media"))) for (const f of fs.readdirSync(path.join(tmp, "media"))) fs.copyFileSync(path.join(tmp, "media", f), path.join(DATA, "media", f));
  fs.rmSync(tmp, { recursive: true, force: true });
  store = new Store(DATA); store.audit(a.user, "백업 복원"); store.save();
  return { ok: true };
});

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = decodeURIComponent(u.pathname);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": req.headers.origin || "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type,X-PC-Client,X-PC-Version", "Access-Control-Max-Age": "600" });
    return res.end();
  }
  if (req.headers.origin && /^chrome-extension:\/\/|^moz-extension:\/\//.test(req.headers.origin)) res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
  try {
    for (const r of routes) {
      if (r.method !== req.method && !(req.method === "HEAD" && r.method === "GET")) continue;
      const m = r.re.exec(p);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = await r.handler(req, res, params, u.searchParams);
      if (out !== undefined && !res.headersSent) send(res, 200, out);
      return;
    }
    if (p.startsWith("/media/")) return serveFile(req, res, path.join(DATA, "media", safeName(p.slice(7))), "public, max-age=86400");
    if (p.startsWith("/api/")) return send(res, 404, { error: "없는 API 입니다" });
    const f = path.join(PUBLIC, path.normalize(p === "/" ? "/index.html" : p).replace(/^(\.\.[/\\])+/, ""));
    if (f.startsWith(PUBLIC) && fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(req, res, f);
    return serveFile(req, res, path.join(PUBLIC, "index.html"));
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "서버 오류: " + e.message });
    if (!e.status) console.error(e);
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`portal-customizer-server v${VERSION} on http://${HOST}:${PORT} (data: ${DATA})`));
  // automatic update check (and apply when enabled); the interval is read again after each check
  const tick = async () => {
    try {
      const s = S().settings;
      const c = await checkUpdate().catch(() => null);
      const st = U.readStatus(DATA);
      const busy = st && !["done", "failed"].includes(st.phase) && Date.now() - Date.parse(st.at || 0) < 10 * 60000;
      const failedBefore = st && st.phase === "failed" && st.to === (c && c.latest);   // do not retry a failed version every minute
      if (c && c.newer && !busy && !failedBefore && s.autoUpdate !== false && process.env.PC_NO_AUTO_UPDATE !== "1") { store.audit("system", "자동 업데이트 시작", "v" + c.latest); store.flush(); await U.apply(DATA, c.latest); }
    } finally { setTimeout(tick, checkMinutes() * 60000).unref(); }
  };
  setTimeout(tick, 15000).unref();
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { store.flush(); } catch (_e) { /* ignore */ } process.exit(0); });
}
module.exports = { server, get store() { return store; }, VERSION };
