import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const data = mkdtempSync(path.join(tmpdir(), "kcsrv-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
execFileSync(process.execPath, [path.join(here, "..", "cli.js"), "admin", "root", "Root"], { env: { ...process.env, PC_DATA: data, PC_PASSWORD: "secret-pass-1" } });
// stand-in for GitHub (publish/latest.json and the release zip); "down" answers 503 to test the fallback
const ghPort = port + 1;
const gh = { pkg: null, down: false };
const ghSrv = http.createServer((req, res) => {
  if (gh.down || !gh.pkg) { res.writeHead(503); return res.end(); }
  req.url = req.url.split("?")[0]; // the server adds a cache-busting query
  if (req.url === "/latest.json") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ version: gh.pkg.version, zipUrl: `http://127.0.0.1:${ghPort}/redirect` })); }
  if (req.url === "/redirect") { res.writeHead(302, { Location: "/pkg.zip" }); return res.end(); }
  if (req.url === "/pkg.zip") { res.writeHead(200, { "Content-Type": "application/zip" }); return res.end(gh.pkg.buf); }
  res.writeHead(404); res.end();
}).listen(ghPort, "127.0.0.1");
const srv = spawn(process.execPath, [path.join(here, "..", "server.js")], { env: { ...process.env, PC_DATA: data, PORT: String(port), PC_NO_AUTO_UPDATE: "1", PC_GITHUB_LATEST: `http://127.0.0.1:${ghPort}/latest.json` }, stdio: "ignore" });
let token = "";
async function call(method, url, body, headers) {
  const r = await fetch(base + url, { method, headers: Object.assign({ Authorization: "Bearer " + token }, body !== undefined && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}, headers || {}),
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, headers: r.headers, body: ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
test.before(async () => { for (let i = 0; i < 50; i += 1) { try { await fetch(base + "/api/health"); return; } catch (_e) { await new Promise((r) => setTimeout(r, 100)); } } });
test.after(() => { srv.kill(); ghSrv.close(); rmSync(data, { recursive: true, force: true }); });

test("health and login", async () => {
  assert.equal((await call("GET", "/api/health")).body.ok, true);
  assert.equal((await call("GET", "/api/layouts")).status, 401);
  assert.equal((await call("POST", "/api/login", { user: "root", password: "wrong" })).status, 401);
  const r = await call("POST", "/api/login", { user: "root", password: "secret-pass-1", label: "test" });
  assert.equal(r.status, 200); token = r.body.token;
  assert.equal((await call("GET", "/api/me")).body.admin.user, "root");
});

test("layouts: send, default, schedule, published json, data url extraction", async () => {
  assert.equal((await call("GET", "/portal-customizer.json")).status, 404);
  const png = "data:image/png;base64," + Buffer.alloc(300, 1).toString("base64");
  const a = await call("POST", "/api/layouts", { name: "Main", layout: { schema: 1, columns: [{ id: "c", width: 300, panels: [{ id: "p", type: "image", src: png }] }] } });
  assert.equal(a.status, 200);
  const list = await call("GET", "/api/layouts");
  assert.equal(list.body.layouts[0].isDefault, true, "first layout becomes default");
  const pub = await call("GET", "/portal-customizer.json", undefined, { "X-PC-Client": "cl-1", "X-PC-Version": "0.3.0" });
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get("access-control-allow-origin"), "*");
  assert.match(pub.body.columns[0].panels[0].src, /^http:\/\/127\.0\.0\.1:\d+\/media\/m[0-9a-f]+\.png$/);
  const media = await fetch(pub.body.columns[0].panels[0].src, { headers: { Range: "bytes=0-9" } });
  assert.equal(media.status, 206); assert.equal((await media.arrayBuffer()).byteLength, 10);
  const now = Date.now();
  const b = await call("POST", "/api/layouts", { name: "Event", layout: { columns: [{ panels: [] }] } });
  await call("PUT", "/api/layouts/" + b.body.layout.id, { start: new Date(now - 3600e3).toISOString(), end: new Date(now + 3600e3).toISOString() });
  const pub2 = await call("GET", "/portal-customizer.json");
  assert.equal(pub2.body.name, "Event");
  assert.notEqual(pub2.body.version, pub.body.version);
  await call("PUT", "/api/layouts/" + b.body.layout.id, { enabled: false });
  assert.equal((await call("GET", "/portal-customizer.json")).body.name, "Main");
  assert.equal((await call("PUT", "/api/layouts/" + b.body.layout.id, { start: new Date(now + 9e6).toISOString(), end: new Date(now).toISOString() })).status, 400);
  const st = await call("GET", "/api/stats?days=7");
  assert.equal(st.body.users, 1); assert.ok(st.body.versions["0.3.0"] >= 1);
  assert.equal((await call("DELETE", "/api/layouts/" + list.body.layouts[0].id)).status, 400, "default cannot be deleted while others exist");
  await call("POST", `/api/layouts/${b.body.layout.id}/default`);
  assert.equal((await call("GET", "/api/layouts")).body.layouts[0].id, b.body.layout.id, "default goes to the top");
  // revisions
  await call("PUT", "/api/layouts/" + b.body.layout.id, { layout: { columns: [{ panels: [{ id: "z", type: "memo" }] }] } });
  const rev = await call("GET", `/api/layouts/${b.body.layout.id}/revisions`);
  assert.equal(rev.body.revisions.length, 1);
  await call("POST", `/api/layouts/${b.body.layout.id}/restore`, { index: 0 });
  assert.equal((await call("GET", "/api/layouts/" + b.body.layout.id)).body.layout.columns[0].panels.length, 0);
});

test("contents and uploads", async () => {
  const g = await call("POST", "/api/groups", { name: "Banners" });
  const up = await call("PUT", "/api/upload?name=hello.mp4", new Uint8Array([1, 2, 3, 4]), { "Content-Type": "video/mp4" });
  assert.match(up.body.url, /\.mp4$/);
  const c = await call("POST", "/api/contents", { type: "video", title: "Clip", url: up.body.url, groupId: g.body.group.id });
  assert.equal(c.status, 200);
  await call("POST", "/api/contents", { type: "html", title: "Notice", html: "<b>hi</b>" });
  assert.equal((await call("GET", "/api/contents?group=" + g.body.group.id)).body.contents.length, 1);
  assert.equal((await call("GET", "/api/contents?type=html")).body.contents.length, 1);
  assert.equal((await call("POST", "/api/contents", { type: "bogus" })).status, 400);
  const groups = (await call("GET", "/api/groups")).body.groups;
  assert.equal(groups[0].count, 1);
});

test("admins, roles, audit, settings", async () => {
  const e = await call("POST", "/api/admins", { user: "ed", password: "editor-pass", role: "editor" });
  assert.equal(e.status, 200);
  const keep = token;
  token = (await call("POST", "/api/login", { user: "ed", password: "editor-pass" })).body.token;
  assert.equal((await call("GET", "/api/admins")).status, 403);
  assert.equal((await call("GET", "/api/layouts")).status, 200);
  token = keep;
  assert.ok((await call("GET", "/api/audit")).body.audit.some((x) => x.action === "관리자 추가"));
  assert.equal((await call("PUT", "/api/settings", { publicUrl: "not a url" })).status, 400);
  assert.equal((await call("PUT", "/api/settings", { publicUrl: "http://portal-admin.example:9150" })).status, 200);
  const before = (await call("GET", "/portal-customizer.json")).body;
  assert.equal((await call("GET", "/api/settings")).body.settings.checkMinutes, 1);
  assert.equal((await call("PUT", "/api/settings", { refreshMinutes: 2, checkMinutes: 3 })).status, 200);
  const after = (await call("GET", "/portal-customizer.json")).body;
  if (before.columns) { assert.equal(after.refreshMinutes, 2); assert.notEqual(after.version, before.version); }
  assert.equal((await call("GET", "/api/settings")).body.settings.checkMinutes, 3);
  assert.ok((await call("GET", "/api/update")).body.releaseUrl.includes("/releases/tag/server-v"));
  const man = await call("GET", "/api/docs/manual");
  assert.equal(man.status, 200); assert.match(man.body.text, /매뉴얼/);
  assert.match((await call("GET", "/api/docs/license")).body.text, /BSL 1\.1/);
  assert.match((await call("GET", "/api/docs/license-text")).body.text, /^Business Source License 1\.1/);
  assert.equal((await call("GET", "/api/docs/constructor")).status, 404);
  const up = await call("PUT", "/api/upload?name=a.png", new Uint8Array([1]));
  assert.match(up.body.url, /^http:\/\/portal-admin\.example:9150\/media\//);
});

test("backup round trip", async () => {
  const b = await call("GET", "/api/backup");
  assert.equal(b.status, 200);
  assert.ok(b.body.length > 100);
  const r = await call("PUT", "/api/backup", new Uint8Array(b.body), { "Content-Type": "application/gzip" });
  assert.equal(r.status, 200);
  assert.ok((await call("GET", "/api/layouts")).body.layouts.length >= 2);
});

test("installations: last check-in per extension install, names given by administrators, notice", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
  const pub = await call("GET", "/portal-customizer.json", undefined, { "X-PC-Client": id, "X-PC-Version": "0.2.11", "User-Agent": ua });
  assert.equal(pub.status, 200); assert.equal(pub.body.client, undefined);
  let list = (await call("GET", "/api/clients")).body;
  const c = list.clients.find((x) => x.id === id);
  assert.ok(c); assert.equal(c.browser, "Edge"); assert.equal(c.os, "Windows"); assert.equal(c.version, "0.2.11"); assert.equal(c.idleDays, 0); assert.equal(c.inactive, false);
  assert.equal(list.inactiveDays, 3);
  assert.equal((await call("PUT", "/api/clients/bad id", { name: "x" })).status, 400);
  // the PC's user names it from the popup: no login, identified by the installation id
  const self = await fetch(base + "/api/client", { method: "PUT", headers: { "Content-Type": "application/json", "X-PC-Client": id }, body: JSON.stringify({ name: "내 자리" }) });
  assert.equal(self.status, 200); assert.equal((await self.json()).client.name, "내 자리");
  assert.equal(self.headers.get("access-control-allow-origin"), "*");
  assert.equal((await fetch(base + "/api/client", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 400);
  assert.equal((await call("GET", "/api/clients")).body.clients.find((x) => x.id === id).namedBy, "user");
  const put = await call("PUT", "/api/clients/" + id, { name: "7층 회의실 A", owner: "홍길동", note: "TV 옆", watch: true });
  assert.equal(put.status, 200); assert.equal(put.body.client.name, "7층 회의실 A"); assert.equal(put.body.client.watch, true);
  assert.equal((await call("PUT", "/api/settings", { welcomeNotice: "문의: 내선 1234", inactiveDays: 5 })).status, 200);
  const pub2 = await call("GET", "/portal-customizer.json", undefined, { "X-PC-Client": id, "User-Agent": ua });
  assert.equal(pub2.body.client.name, "7층 회의실 A"); assert.equal(pub2.body.notice, "문의: 내선 1234");
  // another installation at the same address (test runs on one host): inheritance off for this check
  assert.equal((await call("PUT", "/api/settings", { inheritByIp: false })).status, 200);
  const other = await call("GET", "/portal-customizer.json", undefined, { "X-PC-Client": "99999999-0000" });
  assert.equal(other.body.client, undefined);
  list = (await call("GET", "/api/clients")).body;
  assert.equal(list.inactiveDays, 5); assert.equal(list.clients.find((x) => x.id === id).owner, "홍길동");
  assert.equal((await call("DELETE", "/api/clients/99999999-0000")).status, 200);
  assert.ok(!(await call("GET", "/api/clients")).body.clients.some((x) => x.id === "99999999-0000"));
  assert.equal((await call("PUT", "/api/settings", { inheritByIp: true })).status, 200);
  assert.equal((await call("PUT", "/api/settings", { welcomeNotice: "" })).status, 200);
  // a new installation from the same address gets the name back (reinstall: same browser, the watch moves over)
  const re = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const pubRe = await call("GET", "/portal-customizer.json", undefined, { "X-PC-Client": re, "User-Agent": ua });
  assert.equal(pubRe.body.client && pubRe.body.client.name, "7층 회의실 A", "the name comes back right away");
  list = (await call("GET", "/api/clients")).body;
  const nc = list.clients.find((x) => x.id === re), oc = list.clients.find((x) => x.id === id);
  assert.equal(nc.namedBy, "ip"); assert.equal(nc.owner, "홍길동"); assert.equal(nc.watch, true); assert.equal(oc.watch, false); assert.equal(oc.replacedBy, re);
  // turned off: no inheritance
  assert.equal((await call("PUT", "/api/settings", { inheritByIp: false })).status, 200);
  const off = "ffffffff-1111-2222-3333-444444444444";
  assert.equal((await call("GET", "/portal-customizer.json", undefined, { "X-PC-Client": off })).body.client, undefined);
  assert.equal((await call("GET", "/api/clients")).body.inheritByIp, false);
  assert.equal((await call("PUT", "/api/settings", { inheritByIp: true })).status, 200);
  for (const x of [re, off]) await call("DELETE", "/api/clients/" + x);
});

test("extension distribution: upload, latest.json, publish, delete", async () => {
  const zip = path.join(data, "pkg.zip");
  execFileSync("bash", [path.join(here, "..", "..", "scripts", "build-zip.sh"), zip]);
  const { readFileSync } = await import("node:fs");
  const ver = JSON.parse(readFileSync(path.join(here, "..", "..", "extension", "manifest.json"), "utf8")).version;
  assert.equal((await call("GET", "/ext/latest.json")).status, 404);
  assert.equal((await call("PUT", "/api/extension", new Uint8Array([1, 2, 3]))).status, 400);
  const up = await call("PUT", "/api/extension?notes=" + encodeURIComponent("테스트"), new Uint8Array(readFileSync(zip)));
  assert.equal(up.status, 200); assert.equal(up.body.release.version, ver); assert.equal(up.body.current, ver);
  const latest = await call("GET", "/ext/latest.json");
  assert.equal(latest.body.version, ver); assert.match(latest.body.zipUrl, new RegExp(`/ext/portal-customizer-v${ver.replace(/\./g, "\\.")}\\.zip$`));
  assert.equal(latest.headers.get("access-control-allow-origin"), "*");
  const file = await call("GET", new URL(latest.body.zipUrl).pathname);
  assert.equal(file.status, 200);
  // handed out with this server's connection settings in config.json (update package and installation package)
  const { readEntry } = await import("../lib/zipinfo.js");
  const cfg = JSON.parse(readEntry(file.body, "config.json").toString("utf8"));
  const pub = ((await call("GET", "/api/settings")).body.settings.publicUrl || base).replace(/\/+$/, ""); // the address set on the settings page wins
  assert.equal(cfg.orgConfigUrl, pub + "/portal-customizer.json"); assert.equal(cfg.adminServer, pub); assert.equal(cfg.updateSource, "server");
  assert.equal(JSON.parse(readEntry(file.body, "manifest.json").toString("utf8")).version, ver);
  assert.equal(readEntry(file.body, "updater/install-updater.bat").toString("latin1"), readEntry(readFileSync(zip), "updater/install-updater.bat").toString("latin1"), "other files untouched");
  const inst = await fetch(base + "/ext/install.zip");
  assert.equal(inst.status, 200); assert.match(inst.headers.get("content-disposition"), new RegExp(`portal-customizer-v${ver.replace(/\./g, "\\.")}-install\\.zip`));
  assert.equal(JSON.parse(readEntry(Buffer.from(await inst.arrayBuffer()), "config.json").toString("utf8")).orgConfigUrl, pub + "/portal-customizer.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(data, "handed-out.zip"), file.body);
  execFileSync("unzip", ["-tq", path.join(data, "handed-out.zip")]); // a valid archive
  const trav = await call("GET", "/ext/..%2Fdb.json"); assert.ok(!String(trav.body).includes("tokens") && !(trav.headers.get("content-type") || "").includes("json"));
  assert.equal((await call("GET", "/ext/portal-customizer-v0.0.1.zip")).status, 404);
  assert.equal((await call("DELETE", "/api/extension/" + ver)).status, 400);
  assert.equal((await call("POST", "/api/extension/unpublish")).status, 200);
  assert.equal((await call("GET", "/ext/latest.json")).status, 404);
  assert.equal((await call("POST", `/api/extension/${ver}/publish`)).status, 200);
  assert.equal((await call("GET", "/api/extension")).body.releases[0].notes, "테스트");
  assert.equal((await call("GET", "/api/extension")).body.config.adminServer, pub);
});

test("extension distribution: newest release from GitHub, and the fallback message when it cannot be reached", async () => {
  const { readFileSync } = await import("node:fs");
  const zip = path.join(data, "pkg2.zip");
  execFileSync("bash", [path.join(here, "..", "..", "scripts", "build-zip.sh"), zip]);
  // a newer version than the uploaded one
  const { putEntry } = await import("../lib/zipwrite.js");
  const { readEntry } = await import("../lib/zipinfo.js");
  const m = JSON.parse(readEntry(readFileSync(zip), "manifest.json").toString("utf8")); m.version = "9.8.7";
  gh.pkg = { version: "9.8.7", buf: putEntry(readFileSync(zip), "manifest.json", JSON.stringify(m)) };
  gh.down = true;
  const bad = await call("POST", "/api/extension/github?publish=0");
  assert.equal(bad.status, 502); assert.match(bad.body.error, /2단계/);
  gh.down = false;
  const ok = await call("POST", "/api/extension/github?publish=1");
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.release.version, "9.8.7"); assert.equal(ok.body.current, "9.8.7"); assert.equal(ok.body.release.source, "github");
  const again = await call("POST", "/api/extension/github?publish=1");
  assert.equal(again.body.already, true);
  const pkg = await call("GET", "/ext/portal-customizer-v9.8.7.zip");
  assert.match(JSON.parse(readEntry(pkg.body, "config.json").toString("utf8")).adminServer, /^http/);
  assert.equal((await call("GET", "/ext/latest.json")).body.version, "9.8.7");
});
