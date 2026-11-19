import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const R = createRequire(import.meta.url)("../lib/resolve.js");
const T = (s) => Date.parse(s);
const L = [
  { id: "d", name: "Default", isDefault: true, order: 0 },
  { id: "a", name: "A", start: "2026-12-01T00:00:00Z", end: "2026-12-10T00:00:00Z", order: 1 },
  { id: "b", name: "B", start: "2026-12-05T00:00:00Z", end: "2026-12-20T00:00:00Z", order: 2 },
  { id: "x", name: "Draft", order: 3 },
  { id: "o", name: "Off", start: "2026-11-01T00:00:00Z", enabled: false, order: 4 },
];
test("status", () => {
  assert.equal(R.status(L[0], T("2026-12-02")), "default");
  assert.equal(R.status(L[1], T("2026-11-30")), "upcoming");
  assert.equal(R.status(L[1], T("2026-12-02")), "live");
  assert.equal(R.status(L[1], T("2026-12-10")), "ended");
  assert.equal(R.status(L[3], T("2026-12-02")), "draft");
  assert.equal(R.status(L[4], T("2026-12-02")), "off");
});
test("scheduled wins over default, higher in list wins on overlap", () => {
  assert.equal(R.resolve(L, T("2026-11-20")).layout.id, "d");
  assert.equal(R.resolve(L, T("2026-12-02")).layout.id, "a");
  assert.equal(R.resolve(L, T("2026-12-06")).layout.id, "a");
  assert.equal(R.resolve(L, T("2026-12-12")).layout.id, "b");
  assert.equal(R.resolve(L, T("2026-12-25")).layout.id, "d");
  assert.equal(R.resolve([], T("2026-12-25")).layout, null);
});
test("timeline", () => {
  const seg = R.timeline(L, T("2026-11-25"), T("2026-12-31"));
  assert.deepEqual(seg.map((s) => s.id), ["d", "a", "b", "d"]);
  assert.equal(seg[1].at, T("2026-12-01T00:00:00Z"));
  assert.equal(seg[2].at, T("2026-12-10T00:00:00Z"));
});
test("ordered puts default first", () => {
  assert.deepEqual(R.ordered([{ id: "a", order: 1 }, { id: "d", isDefault: true, order: 5 }]).map((x) => x.id), ["d", "a"]);
});
