// Plugin host: loading from PC_PLUGIN_DIRS, routes, static files, services between plugins, published panels and
// connectors, admin install/enable/remove, a broken plugin not stopping the server.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ZW = require("../lib/zipwrite.js");
const { cleanConnector } = require("../lib/plugins.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const fx = path.join(here, "fixtures", "plugins");
const data = mkdtempSync(path.join(tmpdir(), "pcplug-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
execFileSync(process.execPath, [path.join(here, "..", "cli.js"), "admin", "root", "Root"], { env: { ...process.env, PC_DATA: data, PC_PASSWORD: "secret-pass-1" } });
const dirs = [path.join(fx, "hello"), path.join(fx, "uses-hello"), path.join(fx, "broken")].join(path.delimiter);
const srv = spawn(process.execPath, [path.join(here, "..", "server.js")], { env: { ...process.env, PC_DATA: data, PORT: String(port), PC_NO_AUTO_UPDATE: "1", PC_PLUGIN_DIRS: dirs }, stdio: "ignore" });
let token = "";
async function call(method, url, body, headers) {
  const r = await fetch(base + url, { method, headers: Object.assign({ Authorization: "Bearer " + token }, body !== undefined && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}, headers || {}),
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text() };
}
function zipDir(dir, prefix) {
  let buf = Buffer.alloc(22); buf.writeUInt32LE(0x06054b50, 0);
  const walk = (d, rel) => { for (const f of readdirSync(d)) { const p = path.join(d, f), r = rel + f; if (statSync(p).isDirectory()) walk(p, r + "/"); else buf = ZW.putEntry(buf, prefix + r, readFileSync(p)); } };
  walk(dir, "");
  return buf;
}
test.before(async () => { for (let i = 0; i < 50; i += 1) { try { await fetch(base + "/api/health"); break; } catch (_e) { await new Promise((r) => setTimeout(r, 100)); } }
  token = (await call("POST", "/api/login", { user: "root", password: "secret-pass-1" })).body.token; });
test.after(() => { srv.kill(); rmSync(data, { recursive: true, force: true }); });

test("dev plugins load; a broken one shows its error", async () => {
  const r = await call("GET", "/api/plugins");
  assert.equal(r.status, 200); assert.equal(r.body.dev, true);
  const by = Object.fromEntries(r.body.plugins.map((x) => [x.id, x]));
  assert.equal(by.hello.error, ""); assert.equal(by.hello.dev, true); assert.deepEqual(by.hello.panels, ["Hello board"]);
  assert.deepEqual(by.hello.connectors, ["hello.whoami", "hello.compose"]); assert.deepEqual(by.hello.services, ["identity:hello"]);
  assert.equal(by.hello.adminPages[0].url, "/p/hello/admin.html");
  assert.equal(by.broken.error, "boom");
  assert.equal((await call("GET", "/api/health")).body.ok, true);
});

test("plugin routes, static files and services", async () => {
  assert.deepEqual((await call("GET", "/api/p/hello/ping")).body, { pong: true, id: "hello", config: {} });
  assert.equal((await fetch(base + "/api/p/hello/secret")).status, 401, "plugin uses the server's login");
  assert.equal((await call("GET", "/api/p/hello/secret")).body.user, "root");
  assert.deepEqual((await call("POST", "/api/p/hello/echo/a%20b", { x: 1 })).body, { name: "a b", body: { x: 1 } });
  assert.equal((await call("GET", "/api/p/hello/nothing")).status, 404);
  assert.equal((await call("GET", "/api/p/broken/x")).status, 404);
  assert.equal((await call("GET", "/api/p/nope/x")).status, 404);
  assert.equal((await call("POST", "/api/p/hello/config", { greeting: "안녕" })).status, 200);
  assert.deepEqual((await call("GET", "/api/p/hello/ping")).body.config, { greeting: "안녕" });
  const panel = await fetch(base + "/p/hello/panel.html");
  assert.equal(panel.status, 200); assert.match(await panel.text(), /hello panel/);
  assert.equal((await fetch(base + "/p/hello/..%2f..%2fserver.js")).status, 404, "no way out of public/");
  assert.equal((await fetch(base + "/p/hello/missing.html")).status, 404);
  assert.deepEqual((await call("GET", "/api/p/uses-hello/who")).body.providers, ["hello:hello:hello identity"]);
});

test("published: panels and connectors go to the extension; disabled plugins do not", async () => {
  assert.equal((await call("POST", "/api/layouts", { name: "Main", layout: { schema: 1, columns: [{ id: "c", width: 300, panels: [] }] } })).status, 200);
  let pub = (await call("GET", "/portal-customizer.json")).body;
  const h = pub.plugins.find((x) => x.id === "hello");
  assert.equal(h.base, base + "/p/hello/");
  assert.equal(h.panels[0].url, base + "/p/hello/panel.html"); assert.equal(h.panels[0].height, 300);
  const who = h.connectors.find((c) => c.id === "hello.whoami");
  assert.equal(who.kind, "fetch"); assert.equal(who.request.method, "POST"); assert.equal(who.request.bodyType, "json"); assert.deepEqual(who.response.pick, { name: "user.name" });
  assert.equal(h.connectors.find((c) => c.id === "hello.compose").confirm, "작성 창을 열까요?");
  assert.ok(!pub.plugins.some((x) => x.id === "broken" || x.id === "uses-hello"), "plugins with errors or nothing for the extension are left out");
  assert.equal((await call("POST", "/api/plugins/hello/enabled", { enabled: false })).status, 200);
  pub = (await call("GET", "/portal-customizer.json")).body;
  assert.equal(pub.plugins, undefined);
  assert.equal((await call("GET", "/api/p/hello/ping")).status, 404);
  assert.equal((await fetch(base + "/p/hello/panel.html")).status, 404);
  assert.deepEqual((await call("GET", "/api/p/uses-hello/who")).body.providers, [], "services of a disabled plugin are not used");
  assert.equal((await call("POST", "/api/plugins/hello/enabled", { enabled: true })).status, 200);
});

test("install from zip, replace, remove; dev plugins are protected", async () => {
  const zip = zipDir(path.join(fx, "uses-hello"), "pkg/");
  // same id as a dev plugin: refused
  assert.equal((await call("PUT", "/api/plugins", new Uint8Array(zip), { "Content-Type": "application/zip" })).status, 400);
  const other = Buffer.from(readFileSync(path.join(fx, "uses-hello", "server.js")));
  let z2 = Buffer.alloc(22); z2.writeUInt32LE(0x06054b50, 0);
  z2 = ZW.putEntry(z2, "plugin.json", Buffer.from(JSON.stringify({ id: "zipped", name: "Zipped", version: "1.2.3", main: "server.js" })));
  z2 = ZW.putEntry(z2, "server.js", other);
  const ins = await call("PUT", "/api/plugins", new Uint8Array(z2), { "Content-Type": "application/zip" });
  assert.equal(ins.status, 200); assert.equal(ins.body.plugin.version, "1.2.3"); assert.equal(ins.body.plugin.error, "");
  assert.deepEqual((await call("GET", "/api/p/zipped/who")).body.providers, ["hello:hello:hello identity"]);
  let z3 = Buffer.alloc(22); z3.writeUInt32LE(0x06054b50, 0);
  z3 = ZW.putEntry(z3, "plugin.json", Buffer.from(JSON.stringify({ id: "zipped", name: "Zipped", version: "1.2.4", main: "server.js" })));
  z3 = ZW.putEntry(z3, "server.js", Buffer.from('module.exports = (api) => api.route("GET", "/v", () => ({ v: 2 }));'));
  assert.equal((await call("PUT", "/api/plugins", new Uint8Array(z3), { "Content-Type": "application/zip" })).body.plugin.version, "1.2.4");
  assert.deepEqual((await call("GET", "/api/p/zipped/v")).body, { v: 2 }, "replaced code is loaded again");
  assert.equal((await call("GET", "/api/p/zipped/who")).status, 404);
  let bad = Buffer.alloc(22); bad.writeUInt32LE(0x06054b50, 0);
  bad = ZW.putEntry(bad, "plugin.json", Buffer.from(JSON.stringify({ id: "evil", main: "server.js" })));
  bad = ZW.putEntry(bad, "../escape.js", Buffer.from("x"));
  assert.equal((await call("PUT", "/api/plugins", new Uint8Array(bad), { "Content-Type": "application/zip" })).status, 400);
  assert.equal((await call("DELETE", "/api/plugins/hello")).status, 400, "dev plugin cannot be removed");
  assert.equal((await call("DELETE", "/api/plugins/zipped")).status, 200);
  assert.equal((await call("GET", "/api/p/zipped/v")).status, 404);
  const audit = (await call("GET", "/api/audit")).body.audit.map((x) => x.action);
  assert.ok(audit.includes("플러그인 설치") && audit.includes("플러그인 삭제") && audit.includes("[hello] 설정 저장"));
});

test("connector definitions are checked", () => {
  assert.throws(() => cleanConnector({ id: "x", sites: [] }), /sites/);
  assert.throws(() => cleanConnector({ id: "bad id", sites: ["http://a/"] }), /id/);
  assert.throws(() => cleanConnector({ id: "x", kind: "eval", sites: ["http://a/"] }), /kind/);
  const c = cleanConnector({ id: "x", sites: ["http://a/"], request: { url: "/r", timeoutMs: 999999 } });
  assert.equal(c.request.method, "GET"); assert.equal(c.request.bodyType, "none"); assert.equal(c.request.timeoutMs, 120000);
});
