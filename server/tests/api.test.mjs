import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const data = mkdtempSync(path.join(tmpdir(), "kcsrv-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
execFileSync(process.execPath, [path.join(here, "..", "cli.js"), "admin", "root", "Root"], { env: { ...process.env, PC_DATA: data, PC_PASSWORD: "secret-pass-1" } });
const srv = spawn(process.execPath, [path.join(here, "..", "server.js")], { env: { ...process.env, PC_DATA: data, PORT: String(port), PC_NO_AUTO_UPDATE: "1" }, stdio: "ignore" });
let token = "";
async function call(method, url, body, headers) {
  const r = await fetch(base + url, { method, headers: Object.assign({ Authorization: "Bearer " + token }, body !== undefined && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}, headers || {}),
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, headers: r.headers, body: ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
test.before(async () => { for (let i = 0; i < 50; i += 1) { try { await fetch(base + "/api/health"); return; } catch (_e) { await new Promise((r) => setTimeout(r, 100)); } } });
test.after(() => { srv.kill(); rmSync(data, { recursive: true, force: true }); });

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
  assert.equal(file.status, 200); assert.equal(file.body.length, readFileSync(zip).length);
  const trav = await call("GET", "/ext/..%2Fdb.json"); assert.ok(!String(trav.body).includes("tokens") && !(trav.headers.get("content-type") || "").includes("json"));
  assert.equal((await call("GET", "/ext/portal-customizer-v0.0.1.zip")).status, 404);
  assert.equal((await call("DELETE", "/api/extension/" + ver)).status, 400);
  assert.equal((await call("POST", "/api/extension/unpublish")).status, 200);
  assert.equal((await call("GET", "/ext/latest.json")).status, 404);
  assert.equal((await call("POST", `/api/extension/${ver}/publish`)).status, 200);
  assert.equal((await call("GET", "/api/extension")).body.releases[0].notes, "테스트");
});
