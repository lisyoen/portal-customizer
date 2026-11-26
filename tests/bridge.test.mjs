// Site connector bridge (extension/content/bridge.js): templates, response picking, connector checks and the
// request it sends from the portal tab. Browser globals are stubbed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = require("../extension/lib/layout.js");
// results come from another vm realm: compare as plain JSON
const deq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);

function load(opts = {}) {
  const calls = [];
  const opened = [];
  const sandbox = {
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout, btoa, unescape, encodeURIComponent, JSON, Math, Date, Promise, Object, Array, String, Number, Error,
    location: { href: "http://portal.test/home", origin: "http://portal.test" },
    document: { title: "Portal", querySelectorAll: () => [] },
    window: { addEventListener() {}, confirm: () => opts.confirm !== false, open: (u) => { opened.push(u); return {}; } },
    chrome: { storage: { local: { get: async () => ({}) } } },
    fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => opts.response || JSON.stringify({ user: { name: "홍길동" }, list: [{ n: 1 }, { n: 2 }] }) }; },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(new URL("../extension/content/bridge.js", import.meta.url), "utf8"), sandbox);
  return { B: sandbox.PCBridge, calls, opened };
}
const org = { plugins: [{ id: "hello", name: "Hello", base: "http://admin.test/p/hello/",
  panels: [{ name: "board", title: "Board", url: "http://admin.test/p/hello/panel.html", height: 300, sites: ["http://portal.test/"] }, { name: "other", title: "Other", url: "http://admin.test/p/hello/o.html", sites: ["http://elsewhere.test/"] }],
  connectors: [
    { id: "me", kind: "fetch", sites: ["http://portal.test/"], request: { method: "POST", url: "/api/me?x={{args.q|url}}", headers: { "X-T": "{{args.q}}" }, bodyType: "json",
      body: { q: "{{args.q}}", to: { $each: "{{args.to}}", item: { email: "{{item}}", type: "TO" } }, mime: { $mime: { html: "<p>{{args.q|html}}</p>" } } }, timeoutMs: 5000 },
      response: { type: "json", pick: { name: "user.name", ns: "list[].n" } } },
    { id: "compose", kind: "open", sites: ["http://portal.test/"], url: "/compose?to={{args.to|join|url}}", confirm: "열까요?" },
    { id: "away", kind: "fetch", sites: ["http://portal.test/"], request: { method: "GET", url: "http://evil.test/x", bodyType: "none" }, response: { type: "json" } },
    { id: "nothere", kind: "fetch", sites: ["http://elsewhere.test/"], request: { method: "GET", url: "/x", bodyType: "none" }, response: { type: "json" } },
  ] }] };

test("templates: whole values, filters, $each, $mime, $b64", () => {
  const { B } = load();
  const r = B.render({ n: "{{args.n}}", s: "a={{args.s|url}}&b={{args.s|html}}", list: { $each: "{{args.l}}", item: "{{item}}-{{index}}" }, b: { $b64: "한글" } }, { args: { n: 3, s: "<x y>", l: ["a", "b"] } });
  assert.equal(r.n, 3); assert.equal(r.s, "a=%3Cx%20y%3E&b=&lt;x y&gt;"); deq(r.list, ["a-0", "b-1"]);
  assert.equal(Buffer.from(r.b, "base64").toString("utf8"), "한글");
  assert.throws(() => B.render("{{args.n|nope}}", { args: {} }), /필터/);
  deq(B.getPath({ a: [{ b: 1 }, { b: 2 }] }, "a[].b"), [1, 2]);
});

test("panels: offered by site, url carries the portal origin", () => {
  const { B } = load();
  deq(B.panelDefs(org, "http://portal.test/home").map((d) => d.name), ["board"]);
  const u = new URL(B.panelUrl(B.panelDef(org, "hello", "board"), { id: "p1" }));
  assert.equal(u.searchParams.get("pc_site"), "http://portal.test"); assert.equal(u.searchParams.get("pc_panel"), "p1");
  assert.equal(B.panelDef(org, "hello", "zzz"), null);
});

test("fetch connector: same-origin request with session, json body, picked response", async () => {
  const { B, calls } = load();
  const r = await B.run(org, "hello", "me", { q: "a b", to: ["x@y", "z@w"] });
  deq(r, { status: 200, ok: true, data: { name: "홍길동", ns: [1, 2] } });
  const c = calls[0];
  assert.equal(c.url, "http://portal.test/api/me?x=a%20b"); assert.equal(c.init.method, "POST"); assert.equal(c.init.credentials, "include");
  assert.equal(c.init.headers["X-T"], "a b"); assert.match(c.init.headers["Content-Type"], /application\/json/);
  const body = JSON.parse(c.init.body);
  deq(body.to, [{ email: "x@y", type: "TO" }, { email: "z@w", type: "TO" }]);
  assert.match(body.mime, /^MIME-Version: 1\.0/);
  assert.equal(Buffer.from(body.mime.split("\r\n\r\n")[2].split("\r\n")[0], "base64").toString("utf8"), "<p>a b</p>");
});

test("connector checks: unknown, other site, other origin, cancelled confirm", async () => {
  const { B, opened } = load();
  await assert.rejects(B.run(org, "hello", "nope", {}), /없는 연동/);
  await assert.rejects(B.run(org, "hello", "nothere", {}), /쓸 수 없는/);
  await assert.rejects(B.run(org, "hello", "away", {}), /사이트 주소로만/);
  await assert.rejects(B.run(org, "other", "me", {}), /없는 연동/, "the frame's plugin must be one the server published");
  const org2 = { plugins: org.plugins.concat([{ id: "board", name: "Board", base: "http://admin.test/p/board/", panels: [], connectors: [] }]) };
  deq((await B.run(org2, "board", "me", { q: "x", to: [] })).data, { name: "홍길동", ns: [1, 2] }, "connectors of another plugin of the same server");
  deq(await B.run(org, "hello", "compose", { to: ["a@b", "c@d"] }), { opened: true, url: "http://portal.test/compose?to=a%40b%3Bc%40d" });
  assert.equal(opened.length, 1);
  const { B: B2, opened: o2 } = load({ confirm: false });
  await assert.rejects(B2.run(org, "hello", "compose", { to: [] }), /취소/);
  assert.equal(o2.length, 0);
});

test("layout keeps plugin panels", () => {
  const r = L.validate({ columns: [{ panels: [{ id: "a", type: "plugin", plugin: "hello", panel: "board", title: "B", height: 300 }, { id: "b", type: "plugin", plugin: "Bad Id", panel: "x y" }] }] });
  assert.ok(r.ok);
  const [a, b] = r.layout.columns[0].panels;
  assert.equal(a.plugin, "hello"); assert.equal(a.panel, "board"); assert.equal(b.plugin, ""); assert.equal(b.panel, "");
  deq(Object.keys(L.newPanel("plugin", "x")).sort(), ["height", "id", "panel", "plugin", "title", "type"]);
});
