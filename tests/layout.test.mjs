import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = require("../extension/lib/layout.js");
const V = require("../extension/lib/version.js");

const catalog = [
  { width: 380, flex: false, items: [{ key: "src:/board?id=1", title: "Board", height: 200 }, { key: "src:/board?id=2", title: "News", height: 210 }] },
  { width: 424, flex: false, items: [{ key: "c:MenuCard|Systems", title: "Systems", height: 300 }] },
  { width: 600, flex: true, items: [{ key: "c:Profile", title: "Profile", height: 500 }] },
];

test("nativeKey: frame address (sorted query), else component and title, else title", () => {
  assert.equal(L.nativeKey({ src: "http://a.example/x?b=2&a=1" }), "src:/x?a=1&b=2");
  assert.equal(L.nativeKey({ comp: "MailCard", title: " Mail " }), "c:MailCard|Mail");
  assert.equal(L.nativeKey({ comp: "Weather" }), "c:Weather");
  assert.equal(L.nativeKey({ title: " Mail " }), "title:Mail");
});

test("matchesSite: address prefixes with * wildcards", () => {
  assert.equal(L.matchesSite(["https://portal.example.com/home"], "https://portal.example.com/home?tab=1"), true);
  assert.equal(L.matchesSite("https://portal.example.com/home https://b.example.com/", "https://b.example.com/x"), true);
  assert.equal(L.matchesSite("https://*.example.com/dash", "https://a.example.com/dash/1"), true);
  assert.equal(L.matchesSite("https://portal.example.com/home", "https://portal.example.com/other"), false);
  assert.equal(L.matchesSite("portal.example.com", "https://portal.example.com/"), false);
  assert.equal(L.matchesSite(null, "https://x.example/"), false);
});

test("fromCatalog mirrors the original columns", () => {
  const l = L.fromCatalog(catalog);
  assert.equal(l.columns.length, 3);
  assert.equal(l.columns[0].width, 380);
  assert.equal(l.columns[2].flex, 1);
  assert.equal(l.columns[2].width, null);
  assert.equal(l.columns[2].panels[0].height, 500);
  assert.equal(l.columns[0].panels[1].height, 210);
  assert.ok(L.validate(l).ok);
});

test("fromCatalog keeps the page's spacing: most common gap as default, the rest per column and panel", () => {
  const cat = [
    { width: 366, items: [{ key: "a", height: 200 }, { key: "b", height: 200, gap: 25 }, { key: "c", height: 200, gap: 25 }] },
    { width: 410, gap: 26.4, items: [{ key: "d", height: 600 }] },
    { flex: true, gap: 27.6, items: [{ key: "e", height: 60 }, { key: "f", height: 80, gap: 0 }, { key: "g", height: 500, gap: 0.2 }] },
  ];
  const l = L.fromCatalog(cat);
  assert.deepEqual(l.gaps, { col: 26.5, panel: 25 });
  assert.equal(l.columns[1].gap, undefined);
  assert.equal(l.columns[2].gap, 27.5);
  assert.equal(l.columns[0].panels[1].gap, undefined);
  assert.equal(l.columns[2].panels[1].gap, 0);
  assert.equal(l.columns[2].panels[2].gap, 0);
  assert.equal(L.panelGap(l, l.columns[0].panels[2]), 25);
  assert.equal(L.colGap(l, l.columns[2]), 27.5);
  assert.ok(L.validate(l).ok);
  // nothing measured: defaults as before
  assert.equal(L.fromCatalog([{ width: 300, items: [{ key: "x" }] }]).gaps, undefined);
});

test("matchesPage: the page's own arrangement is left as is, any change is drawn", () => {
  const cat = [
    { width: 366, items: [{ key: "a", height: 200 }, { key: "b", height: 200, gap: 25 }] },
    { flex: true, gap: 27.5, items: [{ key: "e", height: 60 }, { key: "f", height: 80, gap: 0 }] },
  ];
  const l = L.fromCatalog(cat);
  assert.equal(L.matchesPage(l, cat), true);
  assert.equal(L.matchesPage(L.validate(l).layout, cat), true, "survives the server round trip");
  assert.equal(L.sig(l), L.sig(L.clone(l)));
  const moved = L.movePanel(l, l.columns[0].panels[1].id, 1, 0);
  assert.equal(L.matchesPage(moved, cat), false);
  assert.notEqual(L.sig(moved), L.sig(l));
  assert.equal(L.matchesPage(L.setColumn(l, l.columns[0].id, { width: 300 }), cat), false);
  assert.equal(L.matchesPage(L.setGap(l, { panel: l.columns[0].panels[1].id }, 10), cat), false);
  const hid = L.clone(l); hid.columns[1].panels[0].hidden = true;
  assert.equal(L.matchesPage(hid, cat), false);
  // a widget whose height the page sets itself (e.g. fills the window) still matches at another window size ...
  const winH = L.clone(l); winH.columns[1].panels[1].height = 300;
  assert.equal(L.matchesPage(winH, cat), true);
  // ... unless the height was changed by hand
  const tall = L.updatePanel(l, l.columns[0].panels[0].id, { height: 260 });
  assert.equal(tall.columns[0].panels[0].auto, undefined);
  assert.equal(L.matchesPage(tall, cat), false);
  assert.equal(L.updatePanel(l, l.columns[0].panels[0].id, { title: "x", height: 200 }).columns[0].panels[0].auto, true, "unchanged height keeps auto");
  const memo = L.clone(l); memo.columns[0].panels.push({ id: "m", type: "memo", title: "m", text: "x" });
  assert.equal(L.matchesPage(memo, cat), false);
  assert.equal(L.matchesPage(L.fromCatalog([{ width: 300, items: [{ key: "x", height: 100 }] }]), cat), false);
});

test("movePanel within and across columns", () => {
  const l = L.fromCatalog(catalog);
  const [a, b] = l.columns[0].panels.map((p) => p.id);
  let m = L.movePanel(l, a, 0, 2);
  assert.deepEqual(m.columns[0].panels.map((p) => p.id), [b, a]);
  m = L.movePanel(l, a, 2, 0);
  assert.equal(m.columns[0].panels.length, 1);
  assert.equal(m.columns[2].panels[0].id, a);
  assert.equal(l.columns[0].panels.length, 2, "original untouched");
});

test("moveColumn, add/remove column, setColumn", () => {
  const l = L.fromCatalog(catalog);
  const ids = l.columns.map((c) => c.id);
  assert.deepEqual(L.moveColumn(l, ids[2], 0).columns.map((c) => c.id), [ids[2], ids[0], ids[1]]);
  assert.deepEqual(L.moveColumn(l, ids[0], 3).columns.map((c) => c.id), [ids[1], ids[2], ids[0]]);
  const added = L.addColumn(l, 250);
  assert.equal(added.columns.length, 4);
  assert.equal(added.columns[3].width, 250);
  assert.equal(L.removeColumn(added, added.columns[3].id).columns.length, 3);
  const one = { columns: [{ id: "c", width: 300, panels: [] }] };
  assert.equal(L.removeColumn(one, "c").columns.length, 1, "last column kept");
  const f = L.setColumn(l, ids[0], { flex: 1 });
  assert.equal(f.columns[0].flex, 1); assert.equal(f.columns[0].width, null);
  const w = L.setColumn(f, ids[0], { width: 50 });
  assert.equal(w.columns[0].width, 120, "clamped to minimum");
});

test("validate sanitizes unsafe values", () => {
  const r = L.validate({ version: "v1", name: "Org", columns: [{ id: "c", width: 9999, panels: [
    { id: "a", type: "image", src: "javascript:alert(1)", href: "https://ok.example", fit: "weird" },
    { id: "a", type: "links", items: [{ title: "x", url: "javascript:1" }, { title: "y", url: "https://y.example" }] },
    { id: "b", type: "iframe", url: "file:///etc/passwd", height: "12" },
    { id: "c", type: "script" },
    { id: "d", type: "native" },
  ] }] });
  assert.ok(r.ok);
  const p = r.layout.columns[0].panels;
  assert.equal(r.layout.columns[0].width, 3000);
  assert.equal(p.length, 3);
  assert.equal(p[0].src, ""); assert.equal(p[0].href, "https://ok.example"); assert.equal(p[0].fit, "cover");
  assert.notEqual(p[1].id, "a", "duplicate id replaced");
  assert.deepEqual(p[1].items, [{ title: "y", url: "https://y.example" }]);
  assert.equal(p[2].url, ""); assert.equal(p[2].height, 40);
  assert.equal(r.layout.name, "Org");
  assert.equal(L.validate({}).ok, false);
  assert.equal(L.validate({ schema: 99, columns: [{ panels: [] }] }).ok, false);
});

test("validate accepts data: images and wrapped layouts", () => {
  const r = L.validate({ layout: { columns: [{ flex: 1, panels: [{ type: "image", src: "data:image/png;base64,AAAA" }] }] } });
  assert.ok(r.ok);
  assert.equal(r.layout.columns[0].panels[0].src, "data:image/png;base64,AAAA");
  assert.equal(r.layout.columns[0].flex, 1);
});

test("panel add/update/remove and used keys", () => {
  let l = L.fromCatalog(catalog);
  const img = L.newPanel("image");
  l = L.addPanel(l, 1, img);
  assert.equal(l.columns[1].panels[0].id, img.id);
  l = L.updatePanel(l, img.id, { src: "https://img.example/a.png", height: 99 });
  assert.equal(L.findPanel(l, img.id).panel.src, "https://img.example/a.png");
  assert.equal(L.findPanel(l, img.id).panel.height, 99);
  assert.ok(L.usedNativeKeys(l).has("c:Profile"));
  l = L.removePanel(l, img.id);
  assert.equal(L.findPanel(l, img.id), null);
});

test("links text round trip", () => {
  const items = L.parseLinks("Mail | https://mail.example\nhttps://plain.example\nbad | ftp://x");
  assert.deepEqual(items, [{ title: "Mail", url: "https://mail.example" }, { title: "https://plain.example", url: "https://plain.example" }]);
  assert.equal(L.formatLinks(items), "Mail | https://mail.example\nhttps://plain.example");
});

test("hash is stable and version compare works", () => {
  assert.equal(L.hash("abc"), L.hash("abc"));
  assert.notEqual(L.hash("abc"), L.hash("abd"));
  assert.ok(V.isNewer("0.2.0", "0.1.9"));
  assert.ok(!V.isNewer("0.1.0", "0.1.0"));
});

test("iframe options are clamped", () => {
  const r = L.validate({ columns: [{ panels: [{ type: "iframe", url: "http://board.example/p?x=1", refresh: 99999, zoom: 5, scroll: false }, { type: "iframe", url: "https://a.example" }] }] });
  const [a, b] = r.layout.columns[0].panels;
  assert.equal(a.refresh, 1440); assert.equal(a.zoom, 25); assert.equal(a.scroll, false);
  assert.equal(b.refresh, 0); assert.equal(b.zoom, 100); assert.equal(b.scroll, undefined);
});

test("carousel and feed panels are validated", () => {
  const r = L.validate({ columns: [{ panels: [
    { type: "carousel", slides: [{ title: "A", href: "https://a.example", src: "https://img.example/a.png" }, { title: "", src: "javascript:x" }], interval: 9999 },
    { type: "feed", tabs: [{ id: "t1", title: "Board", src: "http://portal.example/board?x=1", write: "ftp://x" }, { id: "t1", title: "Dup", src: "https://b.example" }, {}], view: "weird", limit: 0 },
  ] }] });
  const [c, f] = r.layout.columns[0].panels;
  assert.equal(c.slides.length, 1); assert.equal(c.interval, 600); assert.equal(c.captions, true);
  assert.equal(f.tabs.length, 2); assert.notEqual(f.tabs[1].id, "t1"); assert.equal(f.tabs[0].write, "");
  assert.equal(f.view, "card"); assert.equal(f.limit, 30); assert.equal(f.all, true); assert.equal(f.layer, true);
});

test("links accept an optional image and banner display", () => {
  const items = L.parseLinks("Wiki | https://wiki.example | https://img.example/w.png\nPlain | https://p.example");
  assert.deepEqual(items[0], { title: "Wiki", url: "https://wiki.example", img: "https://img.example/w.png" });
  assert.equal(L.formatLinks(items), "Wiki | https://wiki.example | https://img.example/w.png\nPlain | https://p.example");
  const r = L.validate({ columns: [{ panels: [{ type: "links", display: "grid", items }] }] });
  assert.equal(r.layout.columns[0].panels[0].display, "grid");
});

test("board items: clean, date, merge, sort", () => {
  const now = new Date(2026, 10, 17, 12, 0);
  assert.equal(L.parseDate("공지 2026.11.03", now), new Date(2026, 10, 3).getTime());
  assert.equal(L.parseDate("26-11-05 글", now), new Date(2026, 10, 5).getTime());
  assert.equal(L.parseDate("오늘 09:30", now), new Date(2026, 10, 17, 9, 30).getTime());
  assert.equal(L.parseDate("none", now), 0);
  const items = L.cleanItems([{ text: "  Post   one ", row: "Post one 2026.11.01" }, { text: "1" }, { text: ">" }, { text: "Post one" }, { text: "Post two", row: "2026.11.09" }], 10);
  assert.deepEqual(items.map((x) => x.text), ["Post one", "Post two"]);
  assert.deepEqual(L.sortItems(items, "date").map((x) => x.text), ["Post two", "Post one"]);
  assert.deepEqual(L.mergeRoundRobin([[1, 2, 3], ["a"], ["x", "y"]], 5), [1, "a", "x", 2, "y"]);
});

test("gaps: defaults, overrides, validation", () => {
  let l = L.validate({ columns: [{ id: "a", panels: [{ id: "p1", type: "memo" }, { id: "p2", type: "memo", gap: 999 }] }, { id: "b", gap: -5, panels: [] }] }).layout;
  assert.equal(l.columns[0].panels[1].gap, 200);
  assert.equal(l.columns[1].gap, 0);
  assert.equal(L.panelGap(l, l.columns[0].panels[0]), 16);
  assert.equal(L.colGap(l, l.columns[0]), 16);
  l = L.setGap(l, { defaults: { panel: 10, col: "" } });
  assert.deepEqual(l.gaps, { panel: 10 });
  assert.equal(L.panelGap(l, l.columns[0].panels[0]), 10);
  l = L.setGap(l, { panel: "p1" }, 33.3);
  assert.equal(L.findPanel(l, "p1").panel.gap, 33.5);
  l = L.setGap(l, { panel: "p1" }, null);
  assert.equal("gap" in L.findPanel(l, "p1").panel, false);
  l = L.setGap(l, { defaults: {}, resetOverrides: true });
  assert.equal(l.columns[1].gap, undefined);
  assert.equal(L.validate(l).layout.gaps.panel, 10);
});

test("refreshMinutes: kept when valid, clamped, dropped otherwise", () => {
  const base = { columns: [{ id: "c1", panels: [] }] };
  assert.equal(L.validate(Object.assign({ refreshMinutes: 5 }, base)).layout.refreshMinutes, 5);
  assert.equal(L.validate(Object.assign({ refreshMinutes: 99999 }, base)).layout.refreshMinutes, 1440);
  assert.equal("refreshMinutes" in L.validate(Object.assign({ refreshMinutes: 0 }, base)).layout, false);
  assert.equal("refreshMinutes" in L.validate(Object.assign({ refreshMinutes: "x" }, base)).layout, false);
  assert.equal(L.refreshMinutes("3"), 3);
});

test("widgetRule: container selector + level 1-10, kept by validate", () => {
  assert.deepEqual(L.widgetRule({ container: " main > div.grid ", level: 2 }), { container: "main > div.grid", level: 2 });
  assert.equal(L.widgetRule({ container: "x", level: 0 }), null);
  assert.equal(L.widgetRule({ container: "", level: 2 }), null);
  assert.equal(L.widgetRule({ widget: ".card" }), null);
  assert.equal(L.widgetRule({ container: "x", level: 99 }).level, 10);
  const l = L.validate({ columns: [{ id: "c", panels: [] }], site: { container: "#a", level: 3, pause: ".x" } }).layout;
  assert.deepEqual(l.site, { container: "#a", level: 3 });
});
